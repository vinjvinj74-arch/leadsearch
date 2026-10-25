import { createHmac, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import type { AuthUser } from '../types/session.js';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from '../lib/cookies.js';
import { hashIp, requestIp } from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function hashToken(token: string): string {
  return createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function ipHashForRequest(req: Request): string {
  return hashIp(requestIp(req));
}

export async function createSession(req: Request, res: Response, userId: string): Promise<void> {
  const token = newToken(32);
  const csrfToken = newCsrfToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300);
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), userAgent, ipHashForRequest(req), expiresAt],
  );
  setSessionCookie(res, token);
  setCsrfCookie(res, csrfToken);
}

export async function revokeCurrentSession(req: Request, res: Response): Promise<void> {
  if (req.authSession) {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.authSession.id]);
  }
  clearSessionCookie(res);
  clearCsrfCookie(res);
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) {
    await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [userId, exceptSessionId],
    );
  } else {
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] ?? null;
}

export async function requireUserRecord(userId: string): Promise<UserRow> {
  const user = await findUserById(userId);
  if (!user) throw unauthorized('Sessao invalida.');
  return user;
}
