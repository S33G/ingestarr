import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

export interface CommandOptions {
  shell: false;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

type SpawnedChild = Pick<
  ChildProcessWithoutNullStreams,
  'pid' | 'stdout' | 'stderr' | 'kill' | 'on'
>;
interface TreeKillChild {
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnLike = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => SpawnedChild;
export type TreeKillSpawnLike = (
  executable: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true; stdio: 'ignore' },
) => TreeKillChild;

class CommandError extends Error {
  readonly executable: string;
  readonly args: readonly string[];

  constructor(
    message: string,
    executable: string,
    args: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.executable = executable;
    this.args = [...args];
  }
}

export class CommandTimeoutError extends CommandError {
  readonly code = 'COMMAND_TIMEOUT';
}

export class CommandAbortedError extends CommandError {
  readonly code = 'COMMAND_ABORTED';
}

export class CommandOutputLimitError extends CommandError {
  readonly code = 'COMMAND_OUTPUT_LIMIT';
}

export class CommandExecutionError extends CommandError {
  readonly code = 'COMMAND_EXECUTION_FAILED';
  constructor(
    message: string,
    executable: string,
    args: readonly string[],
    public readonly exitCode?: number,
    public readonly stderr = '',
    options?: ErrorOptions,
  ) {
    super(message, executable, args, options);
  }
}

export interface NodeCommandRunnerDependencies {
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
  killTree?: (child: SpawnedChild) => void | Promise<void>;
  treeKillSpawn?: TreeKillSpawnLike;
  terminationTimeoutMs?: number;
}

function fallbackKill(child: SpawnedChild): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
}

async function terminateWindowsTree(
  child: SpawnedChild,
  spawnTreeKiller: TreeKillSpawnLike,
  timeoutMs: number,
): Promise<void> {
  if (child.pid === undefined) {
    fallbackKill(child);
    return;
  }
  await new Promise<void>((resolve) => {
    let killer: TreeKillChild;
    let finished = false;
    const termination: { timer?: NodeJS.Timeout } = {};
    const finish = (succeeded: boolean) => {
      if (finished) return;
      finished = true;
      if (termination.timer !== undefined) clearTimeout(termination.timer);
      if (!succeeded) fallbackKill(child);
      resolve();
    };
    try {
      killer = spawnTreeKiller('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      fallbackKill(child);
      resolve();
      return;
    }
    killer.on('error', () => finish(false));
    killer.on('close', (code) => finish(code === 0));
    termination.timer = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        // Continue to the target-process fallback.
      }
      finish(false);
    }, timeoutMs);
  });
}

async function defaultKillTree(
  child: SpawnedChild,
  platform: NodeJS.Platform,
  spawnTreeKiller: TreeKillSpawnLike,
  timeoutMs: number,
): Promise<void> {
  if (platform === 'win32') {
    await terminateWindowsTree(child, spawnTreeKiller, timeoutMs);
    return;
  }
  if (child.pid === undefined) {
    fallbackKill(child);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    fallbackKill(child);
  }
}

export class NodeCommandRunner implements CommandRunner {
  private readonly spawn: SpawnLike;
  private readonly platform: NodeJS.Platform;
  private readonly killTree: (child: SpawnedChild) => void | Promise<void>;

  constructor(dependencies: NodeCommandRunnerDependencies = {}) {
    this.spawn = dependencies.spawn ?? (nodeSpawn as SpawnLike);
    this.platform = dependencies.platform ?? process.platform;
    const treeKillSpawn = dependencies.treeKillSpawn ?? (nodeSpawn as TreeKillSpawnLike);
    const terminationTimeoutMs = dependencies.terminationTimeoutMs ?? 1_000;
    this.killTree =
      dependencies.killTree ??
      ((child) => defaultKillTree(child, this.platform, treeKillSpawn, terminationTimeoutMs));
  }

  run(
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    if (options.shell !== false) {
      return Promise.reject(
        new CommandExecutionError('Commands must run with shell disabled', executable, args),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new CommandAbortedError('Command aborted', executable, args));
    }
    return new Promise((resolve, reject) => {
      let child: SpawnedChild;
      try {
        child = this.spawn(executable, [...args], {
          shell: false,
          windowsHide: true,
          detached: this.platform !== 'win32',
          env: { ...process.env, ...options.env, LC_ALL: 'C', LANG: 'C' },
          stdio: 'pipe',
        });
      } catch (error) {
        reject(
          new CommandExecutionError('Failed to start command', executable, args, undefined, '', {
            cause: error,
          }),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let state: 'running' | 'terminating' | 'settled' = 'running';
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const stopRetainingOutput = () => {
        child.stdout.removeListener('data', onStdout);
        child.stderr.removeListener('data', onStderr);
        stdout.length = 0;
        stderr.length = 0;
      };
      const fail = (error: Error) => {
        if (state !== 'running') return;
        state = 'terminating';
        cleanup();
        stopRetainingOutput();
        void Promise.resolve()
          .then(() => this.killTree(child))
          .catch(() => fallbackKill(child))
          .finally(() => {
            state = 'settled';
            reject(error);
          });
      };
      const abort = () => fail(new CommandAbortedError('Command aborted', executable, args));

      function onStdout(chunk: Buffer | string) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += value.byteLength;
        if (stdoutBytes > (options.maxStdoutBytes ?? 4 * 1024 * 1024)) {
          fail(new CommandOutputLimitError('Command stdout limit exceeded', executable, args));
          return;
        }
        stdout.push(value);
      }
      function onStderr(chunk: Buffer | string) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += value.byteLength;
        if (stderrBytes > (options.maxStderrBytes ?? 1024 * 1024)) {
          fail(new CommandOutputLimitError('Command stderr limit exceeded', executable, args));
          return;
        }
        stderr.push(value);
      }
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('error', (error: Error) =>
        fail(
          new CommandExecutionError('Command process failed', executable, args, undefined, '', {
            cause: error,
          }),
        ),
      );
      child.on('close', (code: number | null) => {
        if (state !== 'running') return;
        state = 'settled';
        cleanup();
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? -1,
        };
        if (result.exitCode !== 0) {
          reject(
            new CommandExecutionError(
              `Command exited with code ${String(result.exitCode)}`,
              executable,
              args,
              result.exitCode,
              result.stderr,
            ),
          );
          return;
        }
        resolve(result);
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => fail(new CommandTimeoutError('Command timed out', executable, args)),
          options.timeoutMs,
        );
      }
    });
  }
}

export const nodeCommandRunner = new NodeCommandRunner();
