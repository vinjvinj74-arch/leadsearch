import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  clearSessionCookie,
  setSessionCookie,
} from '../lib/cookies.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { UserRole } from '../plans.js';
import { hashToken, toAuthUser, type UserRow } from '../services/authService.js';

interface SessionRow extends UserRow {
  session_id: string;
}

export async function attachSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cookies = req.cookies as Record<string, string> | undefined;
    const currentToken = cookies?.[SESSION_COOKIE];
    const legacyToken = cookies?.[LEGACY_SESSION_COOKIE];
    const token = currentToken ?? legacyToken;
    if (!token) {
      next();
      return;
    }
    const result = await query<SessionRow>(
      `SELECT s.id AS session_id, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - make_interval(days => $2)
       LIMIT 1`,
      [hashToken(token), config.sessionIdleDays],
    );
    const row = result.rows[0];
    if (row) {
      req.user = toAuthUser(row);
      req.authSession = { id: row.session_id, userId: row.id };
      query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
      if (!currentToken && legacyToken) {
        clearSessionCookie(res);
        setSessionCookie(res, legacyToken);
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user || !req.authSession) {
    next(unauthorized());
    return;
  }
  next();
}

export function requireRole(role: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !req.authSession) {
      next(unauthorized());
      return;
    }
    if (req.user.role !== role) {
      next(forbidden());
      return;
    }
    next();
  };
}
