import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers';

import { packagedPaths } from './packaged-paths.mjs';

const { executable } = await packagedPaths();
const temporary = await mkdtemp(path.join(tmpdir(), 'ingestarr-launch-smoke-'));
const readyFile = path.join(temporary, 'ready.json');
let stderr = '';
// Electron's Linux SUID sandbox requires chrome-sandbox to be owned by root
// with mode 4755, which is not the case in CI runners. Disable it for the
// headless smoke launch so the packaged app can start.
const launchArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
const child = spawn(executable, launchArgs, {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    INGESTARR_SMOKE_READY_FILE: readyFile,
    INGESTARR_SMOKE_USER_DATA: path.join(temporary, 'user-data'),
  },
  shell: false,
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => {
  if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
});
const exited = new Promise((resolve) =>
  child.once('exit', (code, signal) => resolve({ code, signal })),
);

try {
  const deadline = Date.now() + 20_000;
  let ready;
  while (Date.now() < deadline) {
    try {
      ready = JSON.parse(await readFile(readyFile, 'utf8'));
      break;
    } catch {
      const earlyExit = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 100)),
      ]);
      if (earlyExit !== undefined) {
        try {
          ready = JSON.parse(await readFile(readyFile, 'utf8'));
          break;
        } catch {
          throw new Error(
            `Packaged app exited before readiness: ${JSON.stringify(earlyExit)} ${stderr}`,
          );
        }
      }
    }
  }
  if (ready?.status !== 'ready') throw new Error(`Packaged app readiness timed out: ${stderr}`);
  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Packaged app did not exit after readiness')), 5_000),
    ),
  ]);
  if (result.code !== 0) throw new Error(`Packaged app smoke exited unsuccessfully: ${stderr}`);
  console.log(JSON.stringify(ready));
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(temporary, { recursive: true, force: true });
}
