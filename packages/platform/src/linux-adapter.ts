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

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function mountPoints(value: JsonRecord): string[] {
  const values: unknown[] = [];
  if (Array.isArray(value.mountpoints)) values.push(...value.mountpoints);
  else if (Array.isArray(value.MOUNTPOINTS)) values.push(...value.MOUNTPOINTS);
  values.push(value.mountpoint, value.MOUNTPOINT);
  return [
    ...new Set(values.filter((item): item is string => typeof item === 'string' && item !== '')),
  ];
}

const PSEUDO_FILESYSTEMS = new Set([
  'proc',
  'sysfs',
  'devtmpfs',
  'devfs',
  'tmpfs',
  'cgroup',
  'cgroup2',
  'overlay',
  'squashfs',
  'tracefs',
  'debugfs',
]);

function safeMountPoint(value: string, fsType: string | undefined): boolean {
  if (!value.startsWith('/') || value === '/') return false;
  if (value.startsWith('/proc/') || value.startsWith('/sys/') || value.startsWith('/dev/')) {
    return false;
  }
  return fsType === undefined || !PSEUDO_FILESYSTEMS.has(fsType.toLowerCase());
}

function valueFor(record: JsonRecord, lower: string, upper: string): unknown {
  return record[lower] ?? record[upper];
}

function rawFacts(
  record: JsonRecord,
  removable: boolean,
  hotplug: boolean,
  transport: string | undefined,
): Record<string, RawFact> {
  const result: Record<string, RawFact> = { removableDevice: removable, hotplug };
  if (transport !== undefined) result.transport = transport;
  const devicePath = nonEmptyString(valueFor(record, 'path', 'PATH'));
  if (devicePath !== undefined) result.devicePath = devicePath;
  const deviceType = nonEmptyString(valueFor(record, 'type', 'TYPE'));
  if (deviceType !== undefined) result.deviceType = deviceType;
  return result;
}

interface DeviceSignals {
  removable: boolean;
  hotplug: boolean;
  transport?: string;
  diskName?: string;
  deviceVendor?: string;
  deviceModel?: string;
}

// Attributes the kernel exposes as plain, human-readable(-ish) text for an MMC/SD device;
// deliberately excludes cid/csd/scr/ocr, which are raw registers that require bit-level decoding
// against the SD Card Association's register layout and would be guesswork to parse here.
const LINUX_SD_SYSFS_FIELDS = ['name', 'oemid', 'manfid', 'serial', 'date', 'prv'] as const;
type LinuxSdSysfsField = (typeof LINUX_SD_SYSFS_FIELDS)[number];

// Best-effort only: this sysfs path exists solely for kernel `mmc_block` devices (SD/MMC card
// readers wired through the SDIO/MMC bus), not USB mass-storage flash drives, so most removable
// volumes simply won't have it. Reads sysfs directly rather than shelling out to the `mmc-utils`
// CLI, which requires root and is frequently not installed.
async function readLinuxSdSysfsFacts(
  diskName: string,
  fs: AdapterDependencies['fs'],
): Promise<Partial<Record<LinuxSdSysfsField, string>>> {
  if (fs.readFile === undefined) return {};
  const facts: Partial<Record<LinuxSdSysfsField, string>> = {};
  await Promise.all(
    LINUX_SD_SYSFS_FIELDS.map(async (field) => {
      try {
        const raw = await fs.readFile?.(`/sys/class/block/${diskName}/device/${field}`);
        const value = raw?.trim();
        if (value !== undefined && value.length > 0) facts[field] = value;
      } catch {
        // Attribute absent (not an SD/MMC device) or unreadable; never fabricated.
      }
    }),
  );
  return facts;
}

const DEFAULT_SYSTEM_MOUNT_POINTS = ['/', '/boot', '/boot/efi', '/usr', '/var'] as const;

function normalizedMountPoint(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function isSystemMount(value: string, systemMountPoints: ReadonlySet<string>): boolean {
  const mount = normalizedMountPoint(value);
  for (const configured of systemMountPoints) {
    if (mount === configured || (configured !== '/' && mount.startsWith(`${configured}/`))) {
      return true;
    }
  }
  return false;
}

function treeContainsSystemMount(
  record: JsonRecord,
  systemMountPoints: ReadonlySet<string>,
): boolean {
  if (mountPoints(record).some((mount) => isSystemMount(mount, systemMountPoints))) return true;
  const children = valueFor(record, 'children', 'CHILDREN');
  return (
    Array.isArray(children) &&
    children.some((child) => {
      const childRecord = asRecord(child);
      return childRecord !== undefined && treeContainsSystemMount(childRecord, systemMountPoints);
    })
  );
}

async function collectDevice(
  record: JsonRecord,
  parent: DeviceSignals,
  dependencies: AdapterDependencies,
  sources: MountedSourceInfo[],
): Promise<void> {
  const ownTransport = nonEmptyString(valueFor(record, 'tran', 'TRAN'))?.toLowerCase();
  const ownName = nonEmptyString(valueFor(record, 'name', 'NAME'));
  // lsblk reports VENDOR/MODEL on the whole-disk device (e.g. mmcblk0), not on its partitions
  // (e.g. mmcblk0p1) where the actual mountpoint lives, so partitions must inherit them from
  // their parent disk rather than re-reading their own (absent) vendor/model fields.
  const ownVendorRaw = valueFor(record, 'vendor', 'VENDOR');
  const ownVendor = nonEmptyString(typeof ownVendorRaw === 'string' ? ownVendorRaw.trim() : ownVendorRaw);
  const ownModelRaw = valueFor(record, 'model', 'MODEL');
  const ownModel = nonEmptyString(typeof ownModelRaw === 'string' ? ownModelRaw.trim() : ownModelRaw);
  const signals: DeviceSignals = {
    removable: parent.removable || booleanFact(valueFor(record, 'rm', 'RM')) === true,
    hotplug: parent.hotplug || booleanFact(valueFor(record, 'hotplug', 'HOTPLUG')) === true,
    ...(ownTransport === undefined
      ? parent.transport === undefined
        ? {}
        : { transport: parent.transport }
      : { transport: ownTransport }),
    ...(parent.diskName === undefined
      ? ownName === undefined
        ? {}
        : { diskName: ownName }
      : { diskName: parent.diskName }),
    ...((parent.deviceVendor ?? ownVendor) === undefined
      ? {}
      : { deviceVendor: parent.deviceVendor ?? ownVendor }),
    ...((parent.deviceModel ?? ownModel) === undefined
      ? {}
      : { deviceModel: parent.deviceModel ?? ownModel }),
  };
  const removable =
    signals.removable || signals.hotplug || ['usb', 'mmc', 'sd'].includes(signals.transport ?? '');
  const fsType = nonEmptyString(valueFor(record, 'fstype', 'FSTYPE'));
  const label = nonEmptyString(valueFor(record, 'label', 'LABEL'));
  const platformVolumeId = nonEmptyString(valueFor(record, 'uuid', 'UUID'));
  const capacityBytes = safeCapacity(valueFor(record, 'size', 'SIZE'));
  const deviceVendor = signals.deviceVendor;
  const deviceModel = signals.deviceModel;
  if (removable) {
    const sdFacts =
      signals.transport === 'mmc' && signals.diskName !== undefined
        ? await readLinuxSdSysfsFacts(signals.diskName, dependencies.fs)
        : {};
    const sdDeviceModel = deviceModel ?? nonEmptyString(sdFacts.name);
    for (const mountPoint of mountPoints(record)) {
      if (!safeMountPoint(mountPoint, fsType)) continue;
      try {
        const canonicalMountPath = await dependencies.fs.realpath(mountPoint);
        const displayName = label ?? path.posix.basename(canonicalMountPath) ?? canonicalMountPath;
        sources.push({
          sourceType: 'removable-volume',
          canonicalMountPath,
          displayName,
          ...(label === undefined ? {} : { volumeLabel: label }),
          ...(platformVolumeId === undefined ? {} : { platformVolumeId }),
          ...(fsType === undefined ? {} : { fsType }),
          ...(capacityBytes === undefined ? {} : { capacityBytes }),
          ...(deviceVendor === undefined ? {} : { deviceVendor }),
          ...(sdDeviceModel === undefined ? {} : { deviceModel: sdDeviceModel }),
          removable: true,
          rawFacts: {
            ...rawFacts(record, signals.removable, signals.hotplug, signals.transport),
            ...(sdFacts.oemid === undefined ? {} : { sdOemId: sdFacts.oemid }),
            ...(sdFacts.manfid === undefined ? {} : { sdManufacturerId: sdFacts.manfid }),
            ...(sdFacts.serial === undefined ? {} : { sdSerial: sdFacts.serial }),
            ...(sdFacts.date === undefined ? {} : { sdManufactureDate: sdFacts.date }),
            ...(sdFacts.prv === undefined ? {} : { sdProductRevision: sdFacts.prv }),
          },
        });
      } catch {
        // A stale mount entry does not invalidate healthy peers.
      }
    }
  }
  const children = valueFor(record, 'children', 'CHILDREN');
  if (Array.isArray(children)) {
    for (const child of children) {
      const childRecord = asRecord(child);
      if (childRecord !== undefined)
        await collectDevice(childRecord, signals, dependencies, sources);
    }
  }
}

export function createLinuxAdapter(dependencies: AdapterDependencies) {
  return buildAdapter(dependencies, async (signal) => {
    let parsed: unknown;
    try {
      const prefix = ['--json', '--bytes', '--output'] as const;
      let result;
      try {
        result = await dependencies.commandRunner.run(
          'lsblk',
          [
            ...prefix,
            'NAME,PATH,TYPE,RM,HOTPLUG,TRAN,UUID,LABEL,FSTYPE,SIZE,VENDOR,MODEL,MOUNTPOINT,MOUNTPOINTS',
          ],
          commandOptions(signal),
        );
      } catch (error) {
        if (isCancellationError(error, signal)) throw error;
        result = await dependencies.commandRunner.run(
          'lsblk',
          [
            ...prefix,
            'NAME,PATH,TYPE,RM,HOTPLUG,TRAN,UUID,LABEL,FSTYPE,SIZE,VENDOR,MODEL,MOUNTPOINT',
          ],
          commandOptions(signal),
        );
      }
      parsed = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      if (isCancellationError(error, signal)) throw error;
      throw availabilityError('Linux', error);
    }
    const root = asRecord(parsed);
    const devices = root?.blockdevices ?? root?.BLOCKDEVICES;
    if (!Array.isArray(devices))
      throw availabilityError('Linux', new Error('Invalid lsblk schema'));
    const sources: MountedSourceInfo[] = [];
    const systemMountPoints = new Set(
      [...DEFAULT_SYSTEM_MOUNT_POINTS, ...(dependencies.systemMountPoints ?? [])].map(
        normalizedMountPoint,
      ),
    );
    for (const device of devices) {
      const record = asRecord(device);
      if (record === undefined || treeContainsSystemMount(record, systemMountPoints)) continue;
      await collectDevice(record, { removable: false, hotplug: false }, dependencies, sources);
    }
    const seen = new Set<string>();
    return sortSources(
      sources.filter((source) => {
        const key = source.canonicalMountPath;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  });
}
