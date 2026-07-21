import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createContentSecurityPolicy } from './content-security-policy';

describe('renderer Content Security Policy', () => {
  it('keeps the checked-in renderer HTML production-safe', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

    expect(html).toContain(`connect-src 'self'`);
    expect(html).not.toMatch(/localhost|127\.0\.0\.1|ws:/);
  });

  it('allows only same-origin connections in production', () => {
    const policy = createContentSecurityPolicy();

    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toMatch(/localhost|127\.0\.0\.1|ws:/);
  });

  it('allows only the selected Vite origin during development', () => {
    const policy = createContentSecurityPolicy('http://localhost:5173');

    expect(policy).toContain("connect-src 'self' http://localhost:5173 ws://localhost:5173");
    expect(policy).not.toContain('localhost:*');
  });

  it('allows unnonced inline styles only during development, for Vite CSS hot reload', () => {
    const developmentPolicy = createContentSecurityPolicy('http://localhost:5173');
    expect(developmentPolicy).toContain("style-src 'self' 'unsafe-inline'");

    const productionPolicy = createContentSecurityPolicy();
    expect(productionPolicy).toContain("style-src 'self'");
    expect(productionPolicy).not.toContain('unsafe-inline');
  });

  it('rejects non-loopback development origins', () => {
    expect(() => createContentSecurityPolicy('https://example.com')).toThrow(
      'Development CSP origin must be loopback HTTP',
    );
  });
});
