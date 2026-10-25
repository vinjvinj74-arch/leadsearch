import type { Response } from 'express';
import { config } from '../config.js';

export const SESSION_COOKIE = 'ls_session';
export const CSRF_COOKIE = 'ls_csrf';

const baseCookieOptions = {
  sameSite: 'lax' as const,
  secure: config.cookieSecure,
  path: '/',
};

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions,
    httpOnly: true,
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...baseCookieOptions, httpOnly: true });
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    ...baseCookieOptions,
    httpOnly: false,
    maxAge: 24 * 60 * 60 * 1000,
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { ...baseCookieOptions, httpOnly: false });
}
