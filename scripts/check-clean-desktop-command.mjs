import { access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { exit, stderr, stdout } from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dependencyDistDirectories = [
  '../packages/shared-types/dist',
  '../packages/ingest-core/dist',
  '../packages/metadata/dist',
  '../packages/platform/dist',
  '../packages/storage/dist',
].map((value) => fileURLToPath(new URL(value, import.meta.url)));
const desktopBuild = fileURLToPath(new URL('../apps/desktop/.vite', import.meta.url));
const desktopOut = fileURLToPath(new URL('../apps/desktop/out', import.meta.url));
const removeGenerated = (directory) =>
  rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

await Promise.all([
  ...dependencyDistDirectories.map(removeGenerated),
  removeGenerated(desktopBuild),
  removeGenerated(desktopOut),
]);

const result = spawnSync('pnpm', ['--filter', '@ingestarr/desktop', 'package'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});

if (result.status !== 0) {
  stdout.write(result.stdout);
  stderr.write(result.stderr);
  exit(result.status ?? 1);
}

await Promise.all([
  access(new URL('../packages/shared-types/dist/index.js', import.meta.url)),
  access(new URL('../packages/ingest-core/dist/index.js', import.meta.url)),
  access(new URL('../packages/metadata/dist/index.js', import.meta.url)),
  access(new URL('../packages/platform/dist/index.js', import.meta.url)),
  access(new URL('../packages/storage/dist/index.js', import.meta.url)),
  access(new URL('../apps/desktop/.vite/build/main.js', import.meta.url)),
  access(new URL('../apps/desktop/.vite/build/preload.js', import.meta.url)),
  access(new URL('../apps/desktop/.vite/renderer/main_window/index.html', import.meta.url)),
]);

stdout.write('Clean desktop package command prepared all dependencies\n');
