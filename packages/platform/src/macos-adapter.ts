import path from 'node:path';

import {
  availabilityError,
  booleanFact,
  buildAdapter,
  commandOptions,
  isCancellationError,
  nonEmptyString,
  safeCapacity,
  sortSources,
  type AdapterDependencies,
} from './adapter-common.js';
import type { MountedSourceInfo, RawFact } from './platform-adapter.js';

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parsePlist(xml: string): PlistValue {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  let position = 0;
  const skip = () => {
    while (
      position < tokens.length &&
      (tokens[position]?.trim() === '' ||
        /^<\?(?:.|\n)*\?>$/.test(tokens[position] ?? '') ||
        /^<!/.test(tokens[position] ?? '') ||
        /^<\/?plist(?:\s[^>]*)?>$/.test(tokens[position] ?? ''))
    ) {
      position += 1;
    }
  };
  const parseValue = (): PlistValue => {
    skip();
    const token = tokens[position++];
    if (token === '<true/>') return true;
    if (token === '<false/>') return false;
    if (token === '<array/>') return [];
    if (token === '<dict/>') return {};
    if (token === '<string/>' || token === '<data/>') return '';
    if (token === '<dict>') {
      const result: { [key: string]: PlistValue } = {};
      for (;;) {
        skip();
        if (tokens[position] === '</dict>') {
          position += 1;
          return result;
        }
        if (tokens[position++] !== '<key>') throw new Error('Invalid plist dictionary key');
        const key = decodeXml(tokens[position++] ?? '');
        if (tokens[position++] !== '</key>') throw new Error('Invalid plist dictionary key close');
        result[key] = parseValue();
      }
    }
    if (token === '<array>') {
      const result: PlistValue[] = [];
      for (;;) {
        skip();
        if (tokens[position] === '</array>') {
          position += 1;
          return result;
        }
        result.push(parseValue());
      }
    }
    const match = /^<(string|integer|real|date|data)>$/.exec(token ?? '');
    if (match !== null) {
      const closeTag = `</${match[1]}>`;
      // An empty element (e.g. `<string></string>`, which real diskutil output emits for blank
      // facts like MediaName) has no text token between the open and close tags, so the very
      // next token is the closing tag itself rather than content.
      const text = tokens[position] === closeTag ? '' : decodeXml(tokens[position++] ?? '');
      if (tokens[position++] !== closeTag) throw new Error('Invalid plist scalar');
      if (match[1] === 'integer' || match[1] === 'real') {
        const number = Number(text);
        if (!Number.isFinite(number)) throw new Error('Invalid plist number');
        return number;
      }
      return text;
    }
    throw new Error('Invalid plist value');
  };
  const result = parseValue();
  skip();
  if (position !== tokens.length) throw new Error('Unexpected trailing plist data');
  return result;
}

function record(value: unknown): Record<string, PlistValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, PlistValue>)
    : undefined;
}

function collectMountedCandidates(value: PlistValue, result: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectMountedCandidates(child, result);
    return;
  }
  const object = record(value);
  if (object === undefined) return;
  const identifier = nonEmptyString(object.DeviceIdentifier);
  const mountPoint = nonEmptyString(object.MountPoint);
  if (identifier !== undefined && mountPoint !== undefined) result.set(identifier, mountPoint);
  for (const child of Object.values(object)) collectMountedCandidates(child, result);
}

function rawFacts(info: Record<string, PlistValue>, identifier: string): Record<string, RawFact> {
  const facts: Record<string, RawFact> = { deviceIdentifier: identifier };
  for (const [target, source] of [
    ['busProtocol', 'BusProtocol'],
    ['deviceLocation', 'DeviceLocation'],
    ['mediaName', 'MediaName'],
  ] as const) {
    const value = info[source];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      facts[target] = value;
    }
  }
  return facts;
}

export function createMacosAdapter(dependencies: AdapterDependencies) {
  return buildAdapter(dependencies, async (signal) => {
    let list: PlistValue;
    try {
      const result = await dependencies.commandRunner.run(
        '/usr/sbin/diskutil',
        ['list', '-plist'],
        commandOptions(signal),
      );
      list = parsePlist(result.stdout);
    } catch (error) {
      if (isCancellationError(error, signal)) throw error;
      throw availabilityError('macOS', error);
    }
    const candidates = new Map<string, string>();
    collectMountedCandidates(list, candidates);
    const sources: MountedSourceInfo[] = [];
    let failedCandidates = 0;
    for (const [identifier] of candidates) {
      try {
        const result = await dependencies.commandRunner.run(
          '/usr/sbin/diskutil',
          ['info', '-plist', identifier],
          commandOptions(signal),
        );
        const info = record(parsePlist(result.stdout));
        if (info === undefined) throw new Error('Invalid diskutil info plist schema');
        const mountPoint = nonEmptyString(info.MountPoint);
        // Modern diskutil does not always emit a `Mounted` boolean fact; a present `MountPoint`
        // is the authoritative signal that a volume is mounted. Only treat an explicit
        // `Mounted: false` as disqualifying.
        const mounted = booleanFact(info.Mounted);
        const removable = booleanFact(info.RemovableMedia) === true;
        const ejectable = booleanFact(info.Ejectable) === true;
        const external = booleanFact(info.Internal) === false;
        if (
          mounted === false ||
          mountPoint === undefined ||
          mountPoint === '/' ||
          (!removable && !ejectable && !external)
        ) {
          continue;
        }
        const canonicalMountPath = await dependencies.fs.realpath(mountPoint);
        const label =
          nonEmptyString(info.VolumeName) ?? path.posix.basename(canonicalMountPath) ?? mountPoint;
        const volumeId =
          nonEmptyString(info.VolumeUUID) ??
          nonEmptyString(info.MediaUUID) ??
          nonEmptyString(info.DiskUUID);
        const capacityBytes = safeCapacity(info.TotalSize);
        const deviceModel = nonEmptyString(info.MediaName);
        sources.push({
          sourceType: 'removable-volume',
          canonicalMountPath,
          displayName: label,
          volumeLabel: label,
          ...(volumeId === undefined ? {} : { platformVolumeId: volumeId }),
          ...(nonEmptyString(info.FilesystemName) === undefined
            ? {}
            : { fsType: nonEmptyString(info.FilesystemName) }),
          ...(capacityBytes === undefined ? {} : { capacityBytes }),
          // diskutil does not reliably expose a separate reader/card vendor on macOS;
          // MediaName is the closest genuinely-available "model" signal.
          ...(deviceModel === undefined ? {} : { deviceModel }),
          removable: true,
          rawFacts: rawFacts(info, identifier),
        });
      } catch (error) {
        if (isCancellationError(error, signal)) throw error;
        failedCandidates += 1;
        // A malformed or disappearing volume does not invalidate healthy peers.
      }
    }
    if (failedCandidates > 0 && sources.length === 0) {
      throw availabilityError(
        'macOS',
        new Error('No removable sources could be resolved after diskutil info failures'),
      );
    }
    return sortSources(sources);
  });
}
