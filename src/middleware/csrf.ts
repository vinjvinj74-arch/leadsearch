import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { recordAudit } from '../lib/audit.js';
import { CSRF_COOKIE, LEGACY_CSRF_COOKIE } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookies = req.cookies as Record<string, string> | undefined;
  const cookieToken = cookies?.[CSRF_COOKIE] ?? cookies?.[LEGACY_CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || !sameToken(cookieToken, headerToken)) {
    recordAudit(req, 'csrf_rejected', null, null, { path: req.path, method: req.method });
    next(new AppError(403, 'CSRF_INVALID', 'Token CSRF ausente ou invalido. Recarregue a pagina e tente novamente.'));
    return;
  }
  next();
}
