import type { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool.js';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';
import { hashToken, toAuthUser, type UserRow } from '../services/authService.js';

interface SessionRow extends UserRow {
  session_id: string;
}

export async function attachSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
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
       LIMIT 1`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (row) {
      req.user = toAuthUser(row);
      req.authSession = { id: row.session_id, userId: row.id };
      query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
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
