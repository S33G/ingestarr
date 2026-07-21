#!/usr/bin/env node
// Native addons such as better-sqlite3 are compiled against a specific runtime's ABI
// (NODE_MODULE_VERSION). This workspace shares one hoisted node_modules between:
//   - plain Node.js, used by `pnpm test` (workspace packages, vitest)
//   - Electron's embedded Node.js, used by `electron-forge start`/`package`/`make`
// These two runtimes have different ABIs, so switching between "run the app" and "run the
// tests" requires rebuilding the native addon for whichever runtime is about to use it. This
// script makes that automatic and idempotent: it only recompiles when the currently-built
// binary doesn't already match the requested target, so most invocations are a fast no-op.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));

const NATIVE_MODULES = ['better-sqlite3'];

const target = process.argv.includes('--target=node') ? 'node' : 'electron';

// Native addons are loaded lazily (e.g. better-sqlite3 only dlopen()s its .node file when a
// Database is constructed), so merely `require()`-ing the package is not enough to detect an
// ABI mismatch. Each module needs a minimal smoke check that actually touches the addon.
const ADDON_SMOKE_CHECKS = {
  'better-sqlite3': (moduleName) => {
    const Database = require(moduleName);
    new Database(':memory:').close();
  },
};

function loadsUnderCurrentRuntime(moduleName) {
  try {
    (ADDON_SMOKE_CHECKS[moduleName] ?? require)(moduleName);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('NODE_MODULE_VERSION')) return false;
    throw error;
  }
}

// A prior Electron-targeted rebuild (in this shell, or a parent process) can leave npm/pnpm
// config environment variables set (npm_config_runtime, npm_config_target, npm_config_disturl,
// etc.), which node-gyp reads and would otherwise silently redirect this "rebuild for Node"
// step back toward Electron's headers. Clear those specific overrides so the child process
// only reflects the current Node runtime; leave unrelated npm_config_* (e.g. cache/devdir
// locations) untouched.
const ELECTRON_OVERRIDE_ENV_KEYS = [
  'npm_config_runtime',
  'npm_config_target',
  'npm_config_disturl',
  'npm_config_target_arch',
  'npm_config_target_platform',
  'npm_config_arch',
];

function nodeGypEnv() {
  const env = { ...process.env };
  for (const key of ELECTRON_OVERRIDE_ENV_KEYS) delete env[key];
  return env;
}

function rebuildForNode(moduleName) {
  if (loadsUnderCurrentRuntime(moduleName)) return;
  console.log(`[rebuild-native-modules] Rebuilding ${moduleName} for Node ${process.version}...`);
  const moduleDir = path.dirname(require.resolve(`${moduleName}/package.json`));
  const nodeGyp = require.resolve('@electron/node-gyp/bin/node-gyp.js');
  execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release'], {
    cwd: moduleDir,
    stdio: 'inherit',
    env: nodeGypEnv(),
  });
  if (!loadsUnderCurrentRuntime(moduleName)) {
    throw new Error(`${moduleName} still does not load under Node after rebuilding`);
  }
}

async function rebuildForElectron(moduleNames, electronVersion) {
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: desktopRoot,
    projectRootPath: repoRoot,
    electronVersion,
    onlyModules: moduleNames,
  });
}

async function main() {
  if (target === 'node') {
    for (const moduleName of NATIVE_MODULES) rebuildForNode(moduleName);
    console.log('[rebuild-native-modules] Native modules are ready for Node.');
    return;
  }

  let electronVersion;
  try {
    electronVersion = require('electron/package.json').version;
  } catch {
    console.warn(
      '[rebuild-native-modules] Electron is not installed yet; skipping native rebuild. ' +
        'Run `pnpm install` again if `pnpm --filter @ingestarr/desktop dev` fails to load native modules.',
    );
    return;
  }

  console.log(
    `[rebuild-native-modules] Ensuring ${NATIVE_MODULES.join(', ')} match Electron ${electronVersion} ABI...`,
  );
  await rebuildForElectron(NATIVE_MODULES, electronVersion);
  console.log('[rebuild-native-modules] Native modules are ready for Electron.');
}

try {
  await main();
} catch (error) {
  console.error(
    `[rebuild-native-modules] Failed to rebuild native modules for ${target}.\n` +
      'Common fixes: install Xcode Command Line Tools (macOS), Visual Studio Build Tools ' +
      '(Windows), or build-essential/python3 (Linux), then re-run this command.',
  );
  console.error(error);
  process.exitCode = 1;
}
