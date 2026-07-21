import type { IndexHtmlTransformContext, Plugin } from 'vite';

const productionPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ');

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createContentSecurityPolicy(developmentOrigin?: string): string {
  if (!developmentOrigin) {
    return productionPolicy;
  }

  const origin = new URL(developmentOrigin);
  if (origin.protocol !== 'http:' || !loopbackHosts.has(origin.hostname) || !origin.port) {
    throw new Error('Development CSP origin must be loopback HTTP with an explicit port');
  }

  const websocketOrigin = new URL(origin.origin);
  websocketOrigin.protocol = 'ws:';

  return (
    productionPolicy
      .replace(
        "connect-src 'self'",
        `connect-src 'self' ${origin.origin} ${websocketOrigin.origin}`,
      )
      // Vite's dev-mode CSS hot reload injects unnonced inline <style> elements, which a strict
      // `style-src 'self'` blocks. The production build instead emits real <link> stylesheets,
      // so this relaxation only ever applies to the development-origin policy.
      .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  );
}

function developmentOrigin(context: IndexHtmlTransformContext): string | undefined {
  if (!context.server) {
    return undefined;
  }

  const resolvedUrl = context.server.resolvedUrls?.local[0];
  if (resolvedUrl) {
    return new URL(resolvedUrl).origin;
  }

  const port = context.server.config.server.port;
  if (!port) {
    throw new Error('Vite development server port is unavailable for CSP generation');
  }

  const configuredHost = context.server.config.server.host;
  const host =
    typeof configuredHost === 'string' && loopbackHosts.has(configuredHost)
      ? configuredHost
      : 'localhost';

  return `http://${host}:${port}`;
}

export function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'ingestarr-content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const policy = createContentSecurityPolicy(developmentOrigin(context));
        return html.replace(productionPolicy, policy);
      },
    },
  };
}
