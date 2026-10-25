import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import { AppError } from './errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'host.docker.internal',
  'gateway.docker.internal',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan', '.intranet', '.localdomain'];

export function isPrivateIp(address: string): boolean {
  const clean = address.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '';
  const family = net.isIP(clean);
  if (family === 4) {
    const parts = clean.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = clean.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith('ff')) return true;
    if (lower.startsWith('2001:db8')) return true;
    if (lower.startsWith('64:ff9b')) return true;
    if (lower.startsWith('100:')) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    }
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return false;
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'URL invalida.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError(400, 'INVALID_URL', 'Apenas URLs HTTP ou HTTPS sao permitidas.');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'INVALID_URL', 'URLs com credenciais nao sao permitidas.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new AppError(400, 'INVALID_URL', 'Apenas as portas 80 e 443 sao permitidas.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new AppError(400, 'BLOCKED_URL', 'Destino de rede local ou interno bloqueado.');
  }
  return url;
}

export interface PublicResolution {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export async function resolvePublicUrl(raw: string): Promise<PublicResolution> {
  const url = parseHttpUrl(raw);
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '';
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIp(hostname)) {
      throw new AppError(400, 'BLOCKED_URL', 'Destino de rede local ou interno bloqueado.');
    }
    return { url, addresses: [{ address: hostname, family: literalFamily as 4 | 6 }] };
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(400, 'DNS_ERROR', 'Nao foi possivel resolver o dominio informado.');
  }
  if (!results.length) {
    throw new AppError(400, 'DNS_ERROR', 'Dominio sem enderecos publicos.');
  }
  if (results.some((entry) => isPrivateIp(entry.address))) {
    throw new AppError(400, 'BLOCKED_URL', 'O dominio resolve para uma rede local ou interna.');
  }
  return {
    url,
    addresses: results.map((entry) => ({
      address: entry.address,
      family: entry.family === 6 ? 6 : 4,
    })),
  };
}

export interface SafeFetchResult {
  statusCode: number;
  finalUrl: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  redirectCount: number;
  https: boolean;
  elapsedMs: number;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

function requestOnce(
  url: URL,
  address: string,
  family: 4 | 6,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

    const lookup: LookupFunction = (_host, _options, callback) => {
      callback(null, address, family);
    };

    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'LeadSearchBot/1.0 (+verificacao de sites; contato pelo proprietario do sistema)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
        'Accept-Language': 'pt-BR,pt;q=0.8,en;q=0.5',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
      lookup,
      timeout: timeoutMs,
      ...(isHttps ? { servername: net.isIP(hostname) ? undefined : hostname } : {}),
    };

    const req = requestFn(options as http.RequestOptions, (res) => {
      const statusCode = res.statusCode ?? 0;
      const headers = res.headers;
      const contentType = String(headers['content-type'] ?? '').toLowerCase();
      const textLike =
        !contentType ||
        contentType.includes('text/') ||
        contentType.includes('html') ||
        contentType.includes('xml') ||
        contentType.includes('json');

      if (!textLike) {
        res.resume();
        resolve({ statusCode, headers, body: '' });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
        else res.destroy();
      });
      res.on('end', () => {
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (error) => reject(error));
    });

    req.on('timeout', () => req.destroy(new Error('Tempo limite excedido ao acessar o site.')));
    req.on('error', (error) => reject(error));
    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const started = Date.now();

  let current = await resolvePublicUrl(rawUrl);
  let redirectCount = 0;

  for (;;) {
    const picked = current.addresses[0];
    if (!picked) throw new AppError(400, 'BLOCKED_URL', 'Dominio sem endereco utilizavel.');
    const response = await requestOnce(current.url, picked.address, picked.family, timeoutMs, maxBytes);

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) {
        return {
          statusCode: response.statusCode,
          finalUrl: current.url.toString(),
          headers: response.headers,
          body: response.body,
          redirectCount,
          https: current.url.protocol === 'https:',
          elapsedMs: Date.now() - started,
        };
      }
      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw new AppError(400, 'TOO_MANY_REDIRECTS', 'Numero maximo de redirecionamentos excedido.');
      }
      const next = new URL(location, current.url);
      current = await resolvePublicUrl(next.toString());
      continue;
    }

    return {
      statusCode: response.statusCode,
      finalUrl: current.url.toString(),
      headers: response.headers,
      body: response.body,
      redirectCount,
      https: current.url.protocol === 'https:',
      elapsedMs: Date.now() - started,
    };
  }
}
