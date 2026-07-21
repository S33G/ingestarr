import { describe, expect, it, vi } from 'vitest';

import {
  CommandAbortedError,
  createLinuxAdapter,
  createMacosAdapter,
  createPlatformAdapter,
  createWindowsAdapter,
  PlatformAvailabilityError,
  type CommandRunner,
  type PlatformFileSystem,
} from './index.js';

const fs: PlatformFileSystem = {
  realpath: async (value) => value.replace(/\/+$/, '') || '/',
  stat: async () => ({ isDirectory: () => true }),
  access: async () => undefined,
};

function runner(outputs: string[]): CommandRunner {
  return {
    run: vi.fn(async () => ({
      stdout: outputs.shift() ?? '',
      stderr: '',
      exitCode: 0,
    })),
  };
}

describe('macOS mounted source adapter', () => {
  it('parses plist volumes, skips internal peers, and keeps valid peers when one info call is odd', async () => {
    const commands = runner([
      `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
       <dict><key>DeviceIdentifier</key><string>disk2s1</string><key>MountPoint</key><string>/Volumes/Café Card</string></dict>
       <dict><key>DeviceIdentifier</key><string>disk0s2</string><key>MountPoint</key><string>/</string></dict>
       <dict><key>DeviceIdentifier</key><string>disk3s1</string><key>MountPoint</key><string>/Volumes/Odd</string></dict>
       </array></dict></plist>`,
      `<?xml version="1.0"?><plist><dict>
       <key>Mounted</key><true/><key>MountPoint</key><string>/Volumes/Café Card</string>
       <key>RemovableMedia</key><true/><key>Ejectable</key><true/><key>Internal</key><false/>
       <key>VolumeName</key><string>Café Card</string><key>FilesystemName</key><string>ExFAT</string>
       <key>TotalSize</key><integer>64000000000</integer><key>VolumeUUID</key><string>ABC-123</string>
       <key>BusProtocol</key><string>Secure Digital</string>
       <key>MediaName</key><string>SD Card Reader Media</string></dict></plist>`,
      `not plist`,
      `<?xml version="1.0"?><plist><dict><key>Mounted</key><true/><key>MountPoint</key><string>/</string><key>Internal</key><true/></dict></plist>`,
    ]);
    const adapter = createMacosAdapter({ commandRunner: commands, fs });
    await expect(adapter.listMountedSources()).resolves.toEqual([
      expect.objectContaining({
        canonicalMountPath: '/Volumes/Café Card',
        platformVolumeId: 'ABC-123',
        volumeLabel: 'Café Card',
        fsType: 'ExFAT',
        capacityBytes: 64_000_000_000,
        deviceModel: 'SD Card Reader Media',
      }),
    ]);
    expect(commands.run).toHaveBeenNthCalledWith(
      1,
      '/usr/sbin/diskutil',
      ['list', '-plist'],
      expect.objectContaining({ shell: false }),
    );
    expect(commands.run).toHaveBeenNthCalledWith(
      2,
      '/usr/sbin/diskutil',
      ['info', '-plist', 'disk2s1'],
      expect.anything(),
    );
  });

  it('includes a mounted removable volume even when diskutil omits the Mounted key', async () => {
    // Real-world `diskutil info -plist` output for an internal SDXC reader (confirmed against a
    // live macOS host) omits the `Mounted` boolean entirely and only reports `MountPoint` when
    // the volume is actually mounted. Requiring an explicit `Mounted: true` fact silently drops
    // every such card.
    const commands = runner([
      `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
       <dict><key>DeviceIdentifier</key><string>disk4s1</string><key>MountPoint</key><string>/Volumes/Untitled</string></dict>
       </array></dict></plist>`,
      `<?xml version="1.0"?><plist><dict>
       <key>MountPoint</key><string>/Volumes/Untitled</string>
       <key>RemovableMedia</key><true/><key>Ejectable</key><true/><key>Internal</key><true/>
       <key>VolumeName</key><string>Untitled</string><key>FilesystemName</key><string>ExFAT</string>
       <key>TotalSize</key><integer>511801819136</integer><key>VolumeUUID</key><string>B77D2146-C820-317B-92AE-1920911DEE34</string>
       <key>BusProtocol</key><string>Secure Digital</string>
       <key>MediaName</key><string></string></dict></plist>`,
    ]);
    const adapter = createMacosAdapter({ commandRunner: commands, fs });
    await expect(adapter.listMountedSources()).resolves.toEqual([
      expect.objectContaining({
        canonicalMountPath: '/Volumes/Untitled',
        volumeLabel: 'Untitled',
        platformVolumeId: 'B77D2146-C820-317B-92AE-1920911DEE34',
      }),
    ]);
  });

  it('skips a volume with no MountPoint even when other mount facts are absent', async () => {
    const commands = runner([
      `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
       <dict><key>DeviceIdentifier</key><string>disk4</string></dict>
       </array></dict></plist>`,
    ]);
    const adapter = createMacosAdapter({ commandRunner: commands, fs });
    await expect(adapter.listMountedSources()).resolves.toEqual([]);
  });

  it('returns an empty list for no mounted volumes and types total malformed output', async () => {
    const empty = createMacosAdapter({
      commandRunner: runner([
        `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array/></dict></plist>`,
      ]),
      fs,
    });
    await expect(empty.listMountedSources()).resolves.toEqual([]);
    const malformed = createMacosAdapter({ commandRunner: runner(['not plist']), fs });
    await expect(malformed.listMountedSources()).rejects.toBeInstanceOf(PlatformAvailabilityError);
  });

  it('types all per-volume failures while propagating aborts unchanged', async () => {
    const list = `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
      <dict><key>DeviceIdentifier</key><string>disk2s1</string><key>MountPoint</key><string>/Volumes/A</string></dict>
      <dict><key>DeviceIdentifier</key><string>disk3s1</string><key>MountPoint</key><string>/Volumes/B</string></dict>
      </array></dict></plist>`;
    const failedCommands: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: list, stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(new Error('gone'))
        .mockRejectedValueOnce(new Error('permission denied')),
    };
    await expect(
      createMacosAdapter({ commandRunner: failedCommands, fs }).listMountedSources(),
    ).rejects.toBeInstanceOf(PlatformAvailabilityError);

    const abort = new CommandAbortedError('aborted', '/usr/sbin/diskutil', []);
    const abortedCommands: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: list, stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(abort),
    };
    await expect(
      createMacosAdapter({ commandRunner: abortedCommands, fs }).listMountedSources(),
    ).rejects.toBe(abort);
  });

  it('preserves a watcher snapshot when every later info lookup fails', async () => {
    const list = `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
      <dict><key>DeviceIdentifier</key><string>disk2s1</string><key>MountPoint</key><string>/Volumes/A</string></dict>
      </array></dict></plist>`;
    const info = `<?xml version="1.0"?><plist><dict>
      <key>Mounted</key><true/><key>MountPoint</key><string>/Volumes/A</string>
      <key>RemovableMedia</key><true/><key>VolumeName</key><string>A</string>
      </dict></plist>`;
    const commands: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: list, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: info, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: list, stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(new Error('temporary diskutil failure')),
    };
    let poll: (() => void) | undefined;
    const adapter = createMacosAdapter({
      commandRunner: commands,
      fs,
      intervalMs: 1,
      timers: {
        setTimeout(callback) {
          poll = callback;
          return 1;
        },
        clearTimeout: vi.fn(),
      },
    });
    const removals: string[] = [];
    const dispose = await adapter.watchSourceRemoval((source) =>
      removals.push(source.canonicalMountPath),
    );
    poll?.();
    await vi.waitFor(() => expect(commands.run).toHaveBeenCalledTimes(4));
    expect(removals).toEqual([]);
    await dispose();
  });

  it('never surfaces the internal boot volume even when it happens to be ejectable/removable-flagged', async () => {
    // Regression guard: some internal Fusion/APFS boot containers can report stray removable
    // facts, but a mount point of "/" (the boot volume) must never be treated as a source.
    const commands = runner([
      `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
       <dict><key>DeviceIdentifier</key><string>disk0s1</string><key>MountPoint</key><string>/</string></dict>
       </array></dict></plist>`,
      `<?xml version="1.0"?><plist><dict>
       <key>Mounted</key><true/><key>MountPoint</key><string>/</string>
       <key>RemovableMedia</key><true/><key>Ejectable</key><true/><key>Internal</key><true/>
       <key>VolumeName</key><string>Macintosh HD</string></dict></plist>`,
    ]);
    const values = await createMacosAdapter({ commandRunner: commands, fs }).listMountedSources();
    expect(values).toEqual([]);
  });

  it('never surfaces a fixed internal secondary volume that is neither removable, ejectable, nor external', async () => {
    const commands = runner([
      `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
       <dict><key>DeviceIdentifier</key><string>disk0s5</string><key>MountPoint</key><string>/System/Volumes/Data</string></dict>
       </array></dict></plist>`,
      `<?xml version="1.0"?><plist><dict>
       <key>Mounted</key><true/><key>MountPoint</key><string>/System/Volumes/Data</string>
       <key>RemovableMedia</key><false/><key>Ejectable</key><false/><key>Internal</key><true/>
       <key>VolumeName</key><string>Macintosh HD - Data</string></dict></plist>`,
    ]);
    const values = await createMacosAdapter({ commandRunner: commands, fs }).listMountedSources();
    expect(values).toEqual([]);
  });

  it('preserves a watcher snapshot when a removable query fails but internal info succeeds', async () => {
    const removableList = `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
      <dict><key>DeviceIdentifier</key><string>disk2s1</string><key>MountPoint</key><string>/Volumes/A</string></dict>
      </array></dict></plist>`;
    const mixedList = `<?xml version="1.0"?><plist><dict><key>AllDisksAndPartitions</key><array>
      <dict><key>DeviceIdentifier</key><string>disk2s1</string><key>MountPoint</key><string>/Volumes/A</string></dict>
      <dict><key>DeviceIdentifier</key><string>disk0s2</string><key>MountPoint</key><string>/System</string></dict>
      </array></dict></plist>`;
    const removableInfo = `<?xml version="1.0"?><plist><dict>
      <key>Mounted</key><true/><key>MountPoint</key><string>/Volumes/A</string>
      <key>RemovableMedia</key><true/><key>VolumeName</key><string>A</string>
      </dict></plist>`;
    const internalInfo = `<?xml version="1.0"?><plist><dict>
      <key>Mounted</key><true/><key>MountPoint</key><string>/System</string>
      <key>Internal</key><true/></dict></plist>`;
    const commands: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: removableList, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: removableInfo, stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: mixedList, stderr: '', exitCode: 0 })
        .mockRejectedValueOnce(new Error('removable disappeared'))
        .mockResolvedValueOnce({ stdout: internalInfo, stderr: '', exitCode: 0 }),
    };
    let poll: (() => void) | undefined;
    const adapter = createMacosAdapter({
      commandRunner: commands,
      fs,
      intervalMs: 1,
      timers: {
        setTimeout(callback) {
          poll = callback;
          return 1;
        },
        clearTimeout: vi.fn(),
      },
    });
    const removals: string[] = [];
    const dispose = await adapter.watchSourceRemoval((source) =>
      removals.push(source.canonicalMountPath),
    );
    poll?.();
    await vi.waitFor(() => expect(commands.run).toHaveBeenCalledTimes(5));
    expect(removals).toEqual([]);
    await dispose();
  });
});

describe('Windows mounted source adapter', () => {
  it('handles a single JSON object, mounted folders, and only sends a constant encoded command', async () => {
    const commands = runner([
      JSON.stringify({
        Path: '\\\\?\\Volume{ABC}\\',
        AccessPaths: ['E:\\', 'C:\\Mounts\\Camera Card\\'],
        Label: '旅行',
        FileSystem: 'exFAT',
        Capacity: '128000000000',
        DriveType: 2,
        SerialNumber: 'CAFE42',
        Manufacturer: 'SanDisk',
        Model: 'Extreme Pro',
      }),
    ]);
    const adapter = createWindowsAdapter({
      commandRunner: commands,
      fs: { ...fs, realpath: async (value) => value },
    });
    const values = await adapter.listMountedSources();
    expect(values.map((value) => value.canonicalMountPath)).toEqual([
      'C:\\Mounts\\Camera Card\\',
      'E:\\',
    ]);
    expect(values[0]).toMatchObject({
      platformVolumeId: '\\\\?\\Volume{ABC}\\',
      volumeLabel: '旅行',
      capacityBytes: 128_000_000_000,
      deviceVendor: 'SanDisk',
      deviceModel: 'Extreme Pro',
    });
    expect(commands.run).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-EncodedCommand']),
      expect.objectContaining({ shell: false }),
    );
    const args = vi.mocked(commands.run).mock.calls[0]?.[1] ?? [];
    expect(args.join(' ')).not.toContain('Camera Card');
  });

  it('skips malformed peers and omits unsafe capacities and absent strong IDs', async () => {
    const commands = runner([
      JSON.stringify([
        null,
        { AccessPaths: 'not-an-array', DriveType: 2 },
        {
          AccessPaths: ['F:\\'],
          Label: 'No UUID',
          FileSystem: 'FAT32',
          Capacity: '9007199254740993',
          DriveType: 2,
        },
      ]),
    ]);
    const values = await createWindowsAdapter({
      commandRunner: commands,
      fs: { ...fs, realpath: async (value) => value },
    }).listMountedSources();
    expect(values).toHaveLength(1);
    expect(values[0]).not.toHaveProperty('capacityBytes');
    expect(values[0]).not.toHaveProperty('platformVolumeId');
  });

  it('excludes USB-labelled boot/system volumes and honors explicit non-removable facts', async () => {
    const values = await createWindowsAdapter({
      commandRunner: runner([
        JSON.stringify([
          {
            AccessPaths: ['C:\\'],
            BusType: 'USB',
            DriveType: 'Removable',
            IsRemovable: true,
            IsBoot: true,
          },
          {
            AccessPaths: ['S:\\'],
            BusType: 'USB',
            IsRemovable: true,
            IsSystem: true,
          },
          {
            AccessPaths: ['N:\\'],
            BusType: 'USB',
            DriveType: 'Removable',
            IsRemovable: false,
          },
          {
            AccessPaths: ['E:\\'],
            BusType: 'USB',
            IsRemovable: true,
            IsBoot: false,
            IsSystem: false,
          },
        ]),
      ]),
      fs: { ...fs, realpath: async (value) => value },
    }).listMountedSources();
    expect(values.map((value) => value.canonicalMountPath)).toEqual(['E:\\']);
  });

  it('never surfaces a fixed internal secondary data drive with no boot/system flags', async () => {
    // Regression guard: a second internal SATA/NVMe data drive is neither the boot volume nor
    // flagged IsSystem, so exclusion must come from genuine non-removability, not those flags alone.
    const values = await createWindowsAdapter({
      commandRunner: runner([
        JSON.stringify([
          {
            AccessPaths: ['D:\\'],
            BusType: 'SATA',
            DriveType: 'Fixed',
            IsRemovable: false,
            IsBoot: false,
            IsSystem: false,
          },
        ]),
      ]),
      fs: { ...fs, realpath: async (value) => value },
    }).listMountedSources();
    expect(values).toEqual([]);
  });
});

describe('Linux mounted source adapter', () => {
  it('walks nested devices, supports multiple mountpoints, and inherits removable signals', async () => {
    const commands = runner([
      JSON.stringify({
        blockdevices: [
          {
            name: 'sda',
            type: 'disk',
            rm: false,
            hotplug: false,
            tran: 'sata',
            children: [{ name: 'sda1', type: 'part', mountpoint: '/', size: 999 }],
          },
          {
            name: 'mmcblk0',
            type: 'disk',
            rm: true,
            hotplug: true,
            tran: 'mmc',
            children: [
              {
                name: 'mmcblk0p1',
                type: 'part',
                uuid: 'SD-UUID',
                label: 'My SD',
                fstype: 'vfat',
                size: 32000000000,
                vendor: 'Generic  ',
                model: 'STORAGE DEVICE  ',
                mountpoints: ['/media/alice/My SD', '/mnt/镜头'],
              },
            ],
          },
        ],
      }),
    ]);
    const adapter = createLinuxAdapter({ commandRunner: commands, fs });
    const values = await adapter.listMountedSources();
    expect(values.map((value) => value.canonicalMountPath)).toEqual([
      '/media/alice/My SD',
      '/mnt/镜头',
    ]);
    expect(values[0]).toMatchObject({
      platformVolumeId: 'SD-UUID',
      volumeLabel: 'My SD',
      fsType: 'vfat',
      capacityBytes: 32_000_000_000,
      deviceVendor: 'Generic',
      deviceModel: 'STORAGE DEVICE',
    });
    expect(commands.run).toHaveBeenCalledWith(
      'lsblk',
      [
        '--json',
        '--bytes',
        '--output',
        'NAME,PATH,TYPE,RM,HOTPLUG,TRAN,UUID,LABEL,FSTYPE,SIZE,VENDOR,MODEL,MOUNTPOINT,MOUNTPOINTS',
      ],
      expect.objectContaining({ shell: false }),
    );
  });

  it('omits unsafe sizes/UUIDs and rejects a malformed total schema', async () => {
    const valid = createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'sdb',
              rm: true,
              mountpoint: '/media/odd',
              size: '9007199254740993',
            },
            'odd peer',
          ],
        }),
      ]),
      fs,
    });
    const values = await valid.listMountedSources();
    expect(values).toHaveLength(1);
    expect(values[0]).not.toHaveProperty('capacityBytes');
    expect(values[0]).not.toHaveProperty('platformVolumeId');

    const malformed = createLinuxAdapter({
      commandRunner: runner([JSON.stringify({ devices: [] })]),
      fs,
    });
    await expect(malformed.listMountedSources()).rejects.toBeInstanceOf(PlatformAvailabilityError);
  });

  it('falls back to singular MOUNTPOINT output on older lsblk versions', async () => {
    const commands: CommandRunner = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('unknown column: MOUNTPOINTS'))
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            blockdevices: [{ name: 'sdc1', rm: true, mountpoint: '/media/legacy' }],
          }),
          stderr: '',
          exitCode: 0,
        }),
    };
    const values = await createLinuxAdapter({ commandRunner: commands, fs }).listMountedSources();
    expect(values.map((value) => value.canonicalMountPath)).toEqual(['/media/legacy']);
    expect(commands.run).toHaveBeenNthCalledWith(
      2,
      'lsblk',
      [
        '--json',
        '--bytes',
        '--output',
        'NAME,PATH,TYPE,RM,HOTPLUG,TRAN,UUID,LABEL,FSTYPE,SIZE,VENDOR,MODEL,MOUNTPOINT',
      ],
      expect.anything(),
    );
  });

  it('excludes a whole device tree containing system mounts but retains removable siblings', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'sda',
              rm: true,
              hotplug: true,
              children: [
                { name: 'sda1', mountpoint: '/boot/efi' },
                { name: 'sda2', mountpoint: '/media/should-not-appear' },
              ],
            },
            {
              name: 'sdb',
              rm: true,
              children: [{ name: 'sdb1', mountpoint: '/media/keep-me' }],
            },
            {
              name: 'sdc',
              rm: true,
              children: [
                { name: 'sdc1', mountpoint: '/srv/host-data' },
                { name: 'sdc2', mountpoint: '/media/custom-system-peer' },
              ],
            },
          ],
        }),
      ]),
      fs,
      systemMountPoints: ['/srv/host-data'],
    }).listMountedSources();
    expect(values.map((value) => value.canonicalMountPath)).toEqual(['/media/keep-me']);
  });

  it('never surfaces a fixed internal secondary disk that is not removable, hotplug, or a removable bus', async () => {
    // Regression guard: a second internal SATA/NVMe data disk mounted away from the default
    // system mount points must still be excluded, since removability (not mount location) governs.
    const values = await createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'sdb',
              type: 'disk',
              rm: false,
              hotplug: false,
              tran: 'sata',
              children: [{ name: 'sdb1', mountpoint: '/data', rm: false, hotplug: false }],
            },
          ],
        }),
      ]),
      fs,
    }).listMountedSources();
    expect(values).toEqual([]);
  });

  it('excludes the root filesystem device tree regardless of which disk name reports it', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'nvme0n1',
              rm: false,
              children: [
                { name: 'nvme0n1p1', mountpoint: '/boot/efi' },
                { name: 'nvme0n1p2', mountpoint: '/' },
              ],
            },
          ],
        }),
      ]),
      fs,
    }).listMountedSources();
    expect(values).toEqual([]);
  });
});

describe('Linux MMC/SD sysfs metadata', () => {
  const mmcBlockdevices = [
    {
      name: 'mmcblk0',
      type: 'disk',
      rm: true,
      hotplug: true,
      tran: 'mmc',
      children: [
        {
          name: 'mmcblk0p1',
          type: 'part',
          uuid: 'SD-UUID',
          label: 'My SD',
          fstype: 'vfat',
          size: 32_000_000_000,
          mountpoint: '/media/alice/My SD',
        },
      ],
    },
  ];

  function sysfsFs(files: Record<string, string>): PlatformFileSystem {
    return {
      ...fs,
      readFile: async (candidate) => {
        const value = files[candidate];
        if (value === undefined) throw new Error(`ENOENT: ${candidate}`);
        return value;
      },
    };
  }

  it('reads plain-text sysfs SD attributes for the base mmcblk device, not the partition', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([JSON.stringify({ blockdevices: mmcBlockdevices })]),
      fs: sysfsFs({
        '/sys/class/block/mmcblk0/device/name': 'SD16G\n',
        '/sys/class/block/mmcblk0/device/oemid': '0x1234\n',
        '/sys/class/block/mmcblk0/device/manfid': '0x000003\n',
        '/sys/class/block/mmcblk0/device/serial': '0xdeadbeef\n',
        '/sys/class/block/mmcblk0/device/date': '01/2021\n',
        '/sys/class/block/mmcblk0/device/prv': '0x8\n',
      }),
    }).listMountedSources();
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      deviceModel: 'SD16G',
      rawFacts: expect.objectContaining({
        sdOemId: '0x1234',
        sdManufacturerId: '0x000003',
        sdSerial: '0xdeadbeef',
        sdManufactureDate: '01/2021',
        sdProductRevision: '0x8',
      }),
    });
    // Never reads the raw cid/csd/scr/ocr registers, which need SD-spec bitfield decoding.
    expect(values[0]?.rawFacts).not.toHaveProperty('cid');
    expect(values[0]?.rawFacts).not.toHaveProperty('csd');
  });

  it('prefers an lsblk-reported MODEL over the sysfs name when both are present', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'mmcblk0',
              type: 'disk',
              rm: true,
              hotplug: true,
              tran: 'mmc',
              children: [
                {
                  name: 'mmcblk0p1',
                  type: 'part',
                  uuid: 'SD-UUID',
                  label: 'My SD',
                  fstype: 'vfat',
                  size: 32_000_000_000,
                  model: 'Named By Lsblk',
                  mountpoint: '/media/alice/My SD',
                },
              ],
            },
          ],
        }),
      ]),
      fs: sysfsFs({ '/sys/class/block/mmcblk0/device/name': 'SD16G' }),
    }).listMountedSources();
    expect(values[0]).toMatchObject({ deviceModel: 'Named By Lsblk' });
  });

  it('gracefully omits SD metadata when the sysfs path is absent (e.g. a USB flash drive)', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([
        JSON.stringify({
          blockdevices: [
            {
              name: 'sdd',
              type: 'disk',
              rm: true,
              hotplug: true,
              tran: 'usb',
              children: [{ name: 'sdd1', mountpoint: '/media/usb', rm: true }],
            },
          ],
        }),
      ]),
      fs, // no readFile support at all, and no sysfs files even if it did
    }).listMountedSources();
    expect(values).toHaveLength(1);
    expect(values[0]).not.toHaveProperty('deviceModel');
    expect(values[0]?.rawFacts).not.toHaveProperty('sdOemId');
  });

  it('does not fail the whole listing when some sysfs attributes are unreadable', async () => {
    const values = await createLinuxAdapter({
      commandRunner: runner([JSON.stringify({ blockdevices: mmcBlockdevices })]),
      fs: sysfsFs({ '/sys/class/block/mmcblk0/device/name': 'PartialCard' }),
    }).listMountedSources();
    expect(values[0]).toMatchObject({ deviceModel: 'PartialCard' });
    expect(values[0]?.rawFacts).not.toHaveProperty('sdSerial');
  });
});

describe('platform factory and source lookup', () => {
  it('constructs only the requested OS without running commands and resolves manual directories', async () => {
    const commands = runner([]);
    const adapter = createPlatformAdapter('linux', { commandRunner: commands, fs });
    expect(commands.run).not.toHaveBeenCalled();
    await expect(adapter.getSourceInfo('/chosen/folder')).resolves.toMatchObject({
      sourceType: 'folder',
      canonicalMountPath: '/chosen/folder',
    });
    await expect(adapter.getSourceInfo('../relative')).rejects.toThrow(/absolute|relative/i);
  });

  it('rejects unsupported platforms', () => {
    expect(() => createPlatformAdapter('aix', { commandRunner: runner([]), fs })).toThrow(
      /unsupported/i,
    );
  });

  it('preserves AbortError through every adapter without Linux retry or manual fallback', async () => {
    for (const create of [createMacosAdapter, createWindowsAdapter, createLinuxAdapter]) {
      const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const commands: CommandRunner = { run: vi.fn().mockRejectedValue(abort) };
      const stat = vi.fn(async () => ({ isDirectory: () => true }));
      const adapter = create({ commandRunner: commands, fs: { ...fs, stat } });

      await expect(adapter.listMountedSources()).rejects.toBe(abort);
      expect(commands.run).toHaveBeenCalledOnce();

      vi.mocked(commands.run).mockClear();
      await expect(adapter.getSourceInfo('/selected/source')).rejects.toBe(abort);
      expect(commands.run).toHaveBeenCalledOnce();
      expect(stat).not.toHaveBeenCalled();
    }
  });

  it('does not manually fall back when cancellation occurs during a successful listing', async () => {
    const abort = Object.assign(new Error('cancelled while listing'), { name: 'AbortError' });
    const controller = new AbortController();
    const stat = vi.fn(async () => ({ isDirectory: () => true }));
    const commands: CommandRunner = {
      run: vi.fn(async () => {
        controller.abort(abort);
        return {
          stdout: JSON.stringify({ blockdevices: [] }),
          stderr: '',
          exitCode: 0,
        };
      }),
    };
    const adapter = createLinuxAdapter({ commandRunner: commands, fs: { ...fs, stat } });

    await expect(adapter.getSourceInfo('/selected/source', controller.signal)).rejects.toBe(abort);
    expect(stat).not.toHaveBeenCalled();
  });
});
