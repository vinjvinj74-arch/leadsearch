import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { config } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { hashIp, requestIp } from '../lib/http.js';
import { logger } from '../lib/logger.js';

export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", ...config.appOrigins],
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  originAgentCluster: true,
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: config.isProduction
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
    : false,
  xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
});

export function additionalSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

export function enforceHttps(req: Request, res: Response, next: NextFunction): void {
  if (!config.isProduction || !config.appUrl || req.path === '/api/health') {
    next();
    return;
  }
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  if (protocol === 'https') {
    next();
    return;
  }
  res.redirect(308, `${config.appUrl}${req.originalUrl}`);
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  req.clientIpHash = hashIp(requestIp(req));
  res.setHeader('X-Request-Id', req.requestId);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
        userId: req.user?.id ?? null,
      },
      'requisicao',
    );
  });
  next();
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin) res.vary('Origin');
  if (origin && config.appOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function requireSameOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  const fetchSite = req.get('sec-fetch-site');
  const origin = req.get('origin');
  const referer = req.get('referer');
  const host = req.get('host');

  const sameHost = (value: string): boolean => {
    if (!host) return false;
    return value === `https://${host}` || value === `http://${host}`;
  };

  const originAllowed = (value: string): boolean =>
    config.appOrigins.includes(value) || sameHost(value);

  if (fetchSite === 'cross-site') {
    recordAudit(req, 'origin_rejected', null, null, {
      path: req.path,
      method: req.method,
      reason: 'sec_fetch_site_cross_site',
    });
    next(new AppError(403, 'ORIGIN_BLOCKED', 'Origem da requisicao nao permitida.'));
    return;
  }

  if (origin) {
    if (!originAllowed(origin)) {
      recordAudit(req, 'origin_rejected', null, null, {
        path: req.path,
        method: req.method,
        reason: 'origin_not_allowed',
      });
      next(new AppError(403, 'ORIGIN_BLOCKED', 'Origem da requisicao nao permitida.'));
      return;
    }
    next();
    return;
  }

  if (referer) {
    let refererOrigin = '';
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = '';
    }
    if (!refererOrigin || !originAllowed(refererOrigin)) {
      recordAudit(req, 'origin_rejected', null, null, {
        path: req.path,
        method: req.method,
        reason: 'referer_not_allowed',
      });
      next(new AppError(403, 'ORIGIN_BLOCKED', 'Origem da requisicao nao permitida.'));
      return;
    }
  }

  next();
}
