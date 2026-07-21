import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const deployRoot = path.join(tmpdir(), 'ingestarr-desktop-runtime');
const noticeRoot = path.join(tmpdir(), 'Ingestarr Third-Party Notices');

await rm(deployRoot, { recursive: true, force: true });
await rm(noticeRoot, { recursive: true, force: true });

// Invoke pnpm through the current Node executable and pnpm's own entry script (exposed as
// `npm_execpath` when this runs under a pnpm script). This avoids Node 22's refusal to spawn
// `pnpm.cmd` on Windows without a shell (CVE-2024-27980 hardening) and sidesteps shell quoting
// for paths that may contain spaces. Falls back to the platform pnpm binary via a shell when the
// entry script is unavailable (e.g. run outside a pnpm script context).
const pnpmExecPath = process.env.npm_execpath;
function runPnpm(args, extraEnv) {
  const options = {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
  };
  if (pnpmExecPath !== undefined && pnpmExecPath !== '') {
    return spawnSync(process.execPath, [pnpmExecPath, ...args], options);
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return spawnSync(pnpm, args, { ...options, shell: process.platform === 'win32' });
}

function assertSpawned(result, label) {
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`${label} could not be launched: ${result.error.message}`);
  }
}

const result = runPnpm([
  '--filter',
  '@ingestarr/desktop',
  'deploy',
  '--prod',
  '--prefer-offline',
  '--legacy',
  deployRoot,
]);
assertSpawned(result, 'Desktop runtime dependency deployment');
const restored = runPnpm(['install', '--offline', '--frozen-lockfile'], { CI: 'true' });
assertSpawned(restored, 'Workspace dependency state restoration');
if (result.status !== 0) {
  await rm(deployRoot, { recursive: true, force: true });
  throw new Error(`Desktop runtime dependency deployment failed (${String(result.status)})`);
}
if (restored.status !== 0) {
  await rm(deployRoot, { recursive: true, force: true });
  throw new Error(`Workspace dependency state restoration failed (${String(restored.status)})`);
}
await mkdir(noticeRoot, { recursive: true });
const ffmpegPackage = path.join(deployRoot, 'node_modules', 'ffmpeg-static');
const ffmpegMetadata = JSON.parse(await readFile(path.join(ffmpegPackage, 'package.json'), 'utf8'));
const releaseTag = ffmpegMetadata['ffmpeg-static']['binary-release-tag'];
const ffmpegBinary = path.join(
  ffmpegPackage,
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);
const ffmpegChecksum = createHash('sha256')
  .update(await readFile(ffmpegBinary))
  .digest('hex');
const ffmpegVersion =
  spawnSync(ffmpegBinary, ['-version'], { encoding: 'utf8', shell: false })
    .stdout.split(/\r?\n/)[0]
    ?.trim() || 'unavailable';
await Promise.all([
  copyFile(
    path.join(ffmpegPackage, 'LICENSE'),
    path.join(noticeRoot, 'FFmpeg-GPL-3.0-or-later.txt'),
  ),
  copyFile(
    path.join(ffmpegPackage, 'ffmpeg.LICENSE'),
    path.join(noticeRoot, 'FFmpeg-BUILD-LICENSE-NOTICE.txt'),
  ),
  copyFile(
    path.join(ffmpegPackage, 'ffmpeg.README'),
    path.join(noticeRoot, 'FFmpeg-BINARY-README.txt'),
  ),
  writeFile(
    path.join(noticeRoot, 'FFmpeg-NOTICE.txt'),
    [
      'FFmpeg is bundled through ffmpeg-static and is distributed under GPL-3.0-or-later.',
      'Package source: https://github.com/eugeneware/ffmpeg-static',
      `Declared binary release: ${releaseTag}`,
      `Binary release provenance: https://github.com/eugeneware/ffmpeg-static/releases/tag/${releaseTag}`,
      `Packaged binary self-report: ${ffmpegVersion}`,
      `Packaged binary SHA-256: ${ffmpegChecksum}`,
      'The complete corresponding-source/source-offer obligations must be satisfied before distribution.',
      '',
    ].join('\n'),
    'utf8',
  ),
]);
