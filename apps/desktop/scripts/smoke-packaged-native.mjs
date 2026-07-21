import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { packagedPaths } from './packaged-paths.mjs';

if (process.argv[2] === '--inside') {
  const resources = process.argv[3];
  if (!resources) throw new Error('Packaged resources path is required');
  const require = createRequire(path.join(resources, 'app.asar', '.vite/build/main.js'));
  const sharp = require('sharp');
  const Database = require('better-sqlite3');
  const exportedFfmpeg = require('ffmpeg-static');
  const ffmpegPackage = require('ffmpeg-static/package.json');
  const ffmpeg = exportedFfmpeg.includes('app.asar')
    ? exportedFfmpeg.replace('app.asar', 'app.asar.unpacked')
    : exportedFfmpeg;
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  })
    .webp()
    .toBuffer();
  const database = new Database(':memory:');
  database.exec('SELECT 1');
  database.close();
  const ffmpegVersion = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
  const releaseTag = ffmpegPackage['ffmpeg-static']['binary-release-tag'];
  const ffmpegChecksum = createHash('sha256')
    .update(await readFile(ffmpeg))
    .digest('hex');
  const notices = path.join(resources, 'Ingestarr Third-Party Notices');
  const [gpl, notice] = await Promise.all([
    readFile(path.join(notices, 'FFmpeg-GPL-3.0-or-later.txt'), 'utf8'),
    readFile(path.join(notices, 'FFmpeg-NOTICE.txt'), 'utf8'),
  ]);
  if (!gpl.includes('GNU GENERAL PUBLIC LICENSE'))
    throw new Error('Packaged FFmpeg GPL text missing');
  if (!notice.includes('https://github.com/eugeneware/ffmpeg-static')) {
    throw new Error('Packaged FFmpeg source notice missing');
  }
  if (
    !notice.includes(`Declared binary release: ${releaseTag}`) ||
    !notice.includes(`Packaged binary SHA-256: ${ffmpegChecksum}`)
  ) {
    throw new Error('Packaged FFmpeg provenance notice does not match the binary');
  }
  console.log(
    JSON.stringify({
      sharp: sharp.versions.sharp,
      imageBytes: image.length,
      sqlite: true,
      ffmpeg: ffmpegVersion,
      notices: true,
    }),
  );
} else {
  const { desktopRoot, executable, resources } = await packagedPaths();
  const result = spawnSync(executable, [fileURLToPath(import.meta.url), '--inside', resources], {
    cwd: desktopRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`Packaged native smoke failed: ${result.stderr || result.stdout}`);
  }
  process.stdout.write(result.stdout);
}
