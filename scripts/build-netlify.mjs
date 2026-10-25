import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const outputDir = path.join(root, 'dist-netlify');
const apiOrigin = (process.env.API_ORIGIN ?? '').trim().replace(/\/+$/, '');

if (!apiOrigin) {
  console.error(
    'API_ORIGIN nao definido. Informe a URL publica do backend (Railway) para gerar o proxy /api/* no Netlify.',
  );
  process.exit(1);
}

let parsedOrigin;
try {
  parsedOrigin = new URL(apiOrigin);
} catch {
  console.error(`API_ORIGIN invalido: ${apiOrigin}`);
  process.exit(1);
}

if (!['http:', 'https:'].includes(parsedOrigin.protocol)) {
  console.error('API_ORIGIN deve usar http ou https.');
  process.exit(1);
}

if (
  parsedOrigin.pathname !== '/' ||
  parsedOrigin.search ||
  parsedOrigin.hash ||
  parsedOrigin.username ||
  parsedOrigin.password
) {
  console.error('API_ORIGIN deve conter apenas a origem, sem caminho, query ou credenciais.');
  process.exit(1);
}

const apiBase = parsedOrigin.origin;

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(path.join(root, 'index.html'), path.join(outputDir, 'index.html'));

for (const entry of await readdir(publicDir, { withFileTypes: true })) {
  await cp(path.join(publicDir, entry.name), path.join(outputDir, entry.name), { recursive: true });
}

const redirects = [
  `# Proxied API (cookies e CSRF permanecem no mesmo site)`,
  `/api/*  ${apiBase}/api/:splat  200`,
  ``,
  `# SPA fallback`,
  `/*  /index.html  200`,
  ``,
].join('\n');

const headers = [
  `/*`,
  `  Content-Security-Policy: default-src 'self'; base-uri 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; upgrade-insecure-requests`,
  `  X-Content-Type-Options: nosniff`,
  `  X-Frame-Options: DENY`,
  `  Referrer-Policy: strict-origin-when-cross-origin`,
  `  Permissions-Policy: geolocation=(), camera=(), microphone=()`,
  ``,
  `/index.html`,
  `  Cache-Control: no-cache`,
  ``,
].join('\n');

await writeFile(path.join(outputDir, '_redirects'), redirects, 'utf8');
await writeFile(path.join(outputDir, '_headers'), headers, 'utf8');

console.log(`Netlify build pronto em ${outputDir}`);
console.log(`Proxy /api/* -> ${apiBase}`);
