#!/usr/bin/env node
/**
 * Renders the Ingestarr UI with mock data and captures README screenshots.
 *
 * Usage: node scripts/capture-readme-screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/screenshots');
const port = 5199;
const baseUrl = `http://localhost:${port}`;

function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url, { redirect: 'follow' });
        if (response.status < 500) {
          resolve();
          return;
        }
      } catch {
        // retry
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(() => void tick(), 250);
    };
    void tick();
  });
}

function startVite() {
  const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
  const proc = spawn(
    process.execPath,
    [viteBin, '--config', 'vite.readme-screenshots.config.ts'],
    {
      cwd: path.join(root, 'apps/desktop'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  );

  proc.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  proc.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM' || code === 143) {
        resolve();
        return;
      }
      reject(new Error(`Vite exited with code ${String(code)}`));
    });
  });

  return { proc, done };
}

async function capture() {
  await mkdir(outDir, { recursive: true });

  const { proc } = startVite();
  try {
    await waitForServer(baseUrl);

    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1:has-text("Sources")');
    await page.waitForSelector('.capacity-bar', { timeout: 10_000 });

    await page.screenshot({
      path: path.join(outDir, 'sources.png'),
      fullPage: false,
    });

    const canonCard = page.locator('.card-row', { hasText: 'canon-r5' });
    await canonCard.getByRole('button', { name: /^start$/i }).click();
    await page.waitForSelector('h1:has-text("Review source")');
    await page.waitForSelector('.date-select-list');

    await page.screenshot({
      path: path.join(outDir, 'review.png'),
      fullPage: false,
    });

    await page.getByRole('button', { name: /start ingest/i }).click();
    await page.waitForSelector('h1:has-text("Ingest in progress")');
    await page.waitForSelector('.progress-fill');

    await page.screenshot({
      path: path.join(outDir, 'progress.png'),
      fullPage: false,
    });

    await browser.close();
    console.log(`Wrote screenshots to ${outDir}`);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }
}

capture().catch((error) => {
  console.error(error);
  process.exit(1);
});
