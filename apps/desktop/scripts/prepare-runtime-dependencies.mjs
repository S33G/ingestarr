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
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(
  pnpm,
  [
    '--filter',
    '@ingestarr/desktop',
    'deploy',
    '--prod',
    '--prefer-offline',
    '--legacy',
    deployRoot,
  ],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
const restored = spawnSync(pnpm, ['install', '--offline', '--frozen-lockfile'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit',
});
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
