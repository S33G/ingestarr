import { nodeManualSourceAdapter } from './manual-source.js';
import type { AdapterDependencies } from './adapter-common.js';
import { nodeCommandRunner } from './command-runner.js';
import { createLinuxAdapter } from './linux-adapter.js';
import { createMacosAdapter } from './macos-adapter.js';
import type { PlatformAdapter } from './platform-adapter.js';
import { createWindowsAdapter } from './windows-adapter.js';

export type SupportedPlatform = 'darwin' | 'win32' | 'linux';
export type PlatformAdapterDependencies = Partial<AdapterDependencies>;

export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
  dependencies: PlatformAdapterDependencies = {},
): PlatformAdapter {
  const resolved: AdapterDependencies = {
    commandRunner: dependencies.commandRunner ?? nodeCommandRunner,
    fs: dependencies.fs ?? nodeManualSourceAdapter,
    ...(dependencies.intervalMs === undefined ? {} : { intervalMs: dependencies.intervalMs }),
    ...(dependencies.timers === undefined ? {} : { timers: dependencies.timers }),
    ...(dependencies.systemMountPoints === undefined
      ? {}
      : { systemMountPoints: dependencies.systemMountPoints }),
  };
  switch (platform) {
    case 'darwin':
      return createMacosAdapter(resolved);
    case 'win32':
      return createWindowsAdapter(resolved);
    case 'linux':
      return createLinuxAdapter(resolved);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
