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

const WINDOWS_VOLUME_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$volumes = Get-Volume | ForEach-Object {
  $volume = $_
  $partition = Get-Partition -Volume $volume -ErrorAction SilentlyContinue | Select-Object -First 1
  $disk = $partition | Get-Disk -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Path = $volume.Path
    AccessPaths = @((
      @($partition.AccessPaths) + @(
        if ($volume.DriveLetter) { "$($volume.DriveLetter):\" }
      )
    ) | Where-Object { $_ })
    Label = $volume.FileSystemLabel
    FileSystem = $volume.FileSystem
    Capacity = $volume.Size
    DriveType = [string]$volume.DriveType
    SerialNumber = $volume.UniqueId
    BusType = [string]$disk.BusType
    Manufacturer = [string]$disk.Manufacturer
    Model = [string]$disk.FriendlyName
    IsRemovable = (
      ([string]$volume.DriveType -eq 'Removable') -or
      ([string]$disk.BusType -in @('USB', 'SD', 'MMC'))
    )
    IsBoot = [bool]$disk.IsBoot
    IsSystem = [bool]$disk.IsSystem
  }
}
@($volumes) | ConvertTo-Json -Compress -Depth 5
`;

const WINDOWS_VOLUME_SCRIPT_ENCODED = Buffer.from(WINDOWS_VOLUME_SCRIPT, 'utf16le').toString(
  'base64',
);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isMountedPath(value: string): boolean {
  return (
    /^[A-Za-z]:\\$/.test(value) ||
    /^[A-Za-z]:\\.+\\$/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+\\/.test(value)
  );
}

function normalizeWindowsPath(value: string): string {
  if (/^[A-Za-z]:/.test(value)) return `${value[0]?.toUpperCase()}${value.slice(1)}`;
  return value;
}

function volumeId(value: JsonRecord): string | undefined {
  const guid = [value.VolumeGuid, value.Path, value.DeviceID]
    .map(nonEmptyString)
    .find(
      (candidate) => candidate !== undefined && /^\\\\\?\\Volume\{[^}]+\}\\?$/i.test(candidate),
    );
  if (guid !== undefined) return guid;
  const serial = nonEmptyString(value.SerialNumber);
  return serial === undefined ? undefined : `serial:${serial}`;
}

function rawFacts(value: JsonRecord): Record<string, RawFact> {
  const result: Record<string, RawFact> = {};
  const driveType = safeCapacity(value.DriveType);
  if (driveType !== undefined) result.driveType = driveType;
  const pathValue = nonEmptyString(value.Path);
  if (pathValue !== undefined) result.volumeGuidPath = pathValue;
  const busType = nonEmptyString(value.BusType);
  if (busType !== undefined) result.busType = busType;
  const isBoot = booleanFact(value.IsBoot);
  if (isBoot !== undefined) result.isBoot = isBoot;
  const isSystem = booleanFact(value.IsSystem);
  if (isSystem !== undefined) result.isSystem = isSystem;
  return result;
}

export function createWindowsAdapter(dependencies: AdapterDependencies) {
  return buildAdapter(dependencies, async (signal) => {
    let parsed: unknown;
    try {
      const result = await dependencies.commandRunner.run(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          WINDOWS_VOLUME_SCRIPT_ENCODED,
        ],
        commandOptions(signal),
      );
      parsed = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      if (isCancellationError(error, signal)) throw error;
      throw availabilityError('Windows', error);
    }
    const records = (Array.isArray(parsed) ? parsed : [parsed])
      .map(asRecord)
      .filter((value): value is JsonRecord => value !== undefined);
    if (
      records.length === 0 &&
      parsed !== null &&
      !(Array.isArray(parsed) && parsed.length === 0)
    ) {
      throw availabilityError('Windows', new Error('Invalid PowerShell JSON schema'));
    }
    const sources: MountedSourceInfo[] = [];
    const seen = new Set<string>();
    for (const value of records) {
      try {
        const isBoot = booleanFact(value.IsBoot) === true;
        const isSystem = booleanFact(value.IsSystem) === true;
        const explicitRemovable = booleanFact(value.IsRemovable);
        if (isBoot || isSystem || explicitRemovable === false) continue;
        const removable =
          explicitRemovable === true ||
          (explicitRemovable === undefined &&
            (safeCapacity(value.DriveType) === 2 ||
              nonEmptyString(value.DriveType)?.toLowerCase() === 'removable' ||
              ['usb', 'sd', 'mmc'].includes(nonEmptyString(value.BusType)?.toLowerCase() ?? '')));
        if (!removable) continue;
        const label = nonEmptyString(value.Label);
        const fsType = nonEmptyString(value.FileSystem);
        const capacityBytes = safeCapacity(value.Capacity);
        const platformVolumeId = volumeId(value);
        const deviceVendor = nonEmptyString(value.Manufacturer);
        const deviceModel = nonEmptyString(value.Model);
        const accesses = [
          ...stringArray(value.AccessPaths),
          ...stringArray(value.DriveLetter),
          ...stringArray(value.MountPoints),
        ];
        for (const access of accesses) {
          if (!isMountedPath(access)) continue;
          const canonicalMountPath = normalizeWindowsPath(await dependencies.fs.realpath(access));
          const dedupe = canonicalMountPath.toLocaleLowerCase('en-US').replace(/[\\]+$/, '');
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const displayName =
            label ??
            path.win32.basename(canonicalMountPath.replace(/[\\]+$/, '')) ??
            canonicalMountPath;
          sources.push({
            sourceType: 'removable-volume',
            canonicalMountPath,
            displayName,
            ...(label === undefined ? {} : { volumeLabel: label }),
            ...(platformVolumeId === undefined ? {} : { platformVolumeId }),
            ...(fsType === undefined ? {} : { fsType }),
            ...(capacityBytes === undefined ? {} : { capacityBytes }),
            ...(deviceVendor === undefined ? {} : { deviceVendor }),
            ...(deviceModel === undefined ? {} : { deviceModel }),
            removable: true,
            rawFacts: rawFacts(value),
          });
        }
      } catch {
        // Ignore one malformed or disappearing volume while preserving healthy peers.
      }
    }
    return sortSources(sources);
  });
}
