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
  role?: 'user' | 'admin';
}

export interface UserSubscriptionRow {
  plan_id: string | null;
  credits_limit: number;
  credits_used: number;
  credits_reset_at: Date | null;
  status: string;
}

export function toAuthUser(
  row: UserRow,
  subscription?: UserSubscriptionRow | null,
): AuthUser {
  const creditsLimit = subscription?.credits_limit ?? 0;
  const creditsUsed = subscription?.credits_used ?? 0;
  const creditsRemaining = Math.max(0, creditsLimit - creditsUsed);
  const role = (row as any).role ?? 'user';
  const needsUpgrade = role === 'admin' ? false : !subscription?.plan_id || creditsLimit === 0 || creditsRemaining <= 0;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    role,
    planId: subscription?.plan_id ?? null,
    creditsLimit,
    creditsUsed,
    creditsRemaining,
    needsUpgrade,
  };
}

export async function getUserSubscription(userId: string): Promise<UserSubscriptionRow | null> {
  const result = await query<UserSubscriptionRow>(
    `SELECT plan_id, credits_limit, credits_used, credits_reset_at, status
     FROM user_subscriptions
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
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

export async function ensureUserSubscription(userId: string): Promise<UserSubscriptionRow> {
  try {
    const existing = await getUserSubscription(userId);
    if (existing) {
      const now = new Date();
      if (existing.credits_reset_at && existing.credits_reset_at <= now) {
        try {
          const reset = await query<UserSubscriptionRow>(
            `UPDATE user_subscriptions
             SET credits_used = 0,
                 credits_reset_at = date_trunc('month', now()) + interval '1 month',
                 updated_at = now()
             WHERE user_id = $1
             RETURNING plan_id, credits_limit, credits_used, credits_reset_at, status`,
            [userId],
          );
          return reset.rows[0] ?? existing;
        } catch {
          return existing;
        }
      }
      return existing;
    }

    try {
      const created = await query<UserSubscriptionRow>(
        `INSERT INTO user_subscriptions (user_id, plan_id, status, credits_limit, credits_used, credits_reset_at)
         VALUES ($1, NULL, 'active', 0, 0, date_trunc('month', now()) + interval '1 month')
         ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
         RETURNING plan_id, credits_limit, credits_used, credits_reset_at, status`,
        [userId],
      );
      return created.rows[0] ?? { plan_id: null, credits_limit: 0, credits_used: 0, credits_reset_at: null, status: 'active' };
    } catch {
      return { plan_id: null, credits_limit: 0, credits_used: 0, credits_reset_at: null, status: 'active' };
    }
  } catch {
    return { plan_id: null, credits_limit: 0, credits_used: 0, credits_reset_at: null, status: 'active' };
  }
}

export async function assignUserPlan(userId: string, planId: 'basico' | 'ilimitado'): Promise<void> {
  const plan = await query<{ monthly_credits: number }>('SELECT monthly_credits FROM plans WHERE id = $1', [planId]);
  const limit = plan.rows[0]?.monthly_credits ?? (planId === 'ilimitado' ? 150 : 25);
  await query(
    `INSERT INTO user_subscriptions (user_id, plan_id, status, credits_limit, credits_used, credits_reset_at)
     VALUES ($1, $2, 'active', $3, 0, date_trunc('month', now()) + interval '1 month')
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       status = 'active',
       credits_limit = EXCLUDED.credits_limit,
       credits_used = 0,
       credits_reset_at = date_trunc('month', now()) + interval '1 month',
       updated_at = now()`,
    [userId, planId, limit],
  );
}

export async function consumeSearchCredit(userId: string, role: string): Promise<void> {
  if (role === 'admin') return;
  try {
    const sub = await ensureUserSubscription(userId);
    if (!sub.plan_id) throw unauthorized('Plano necessario para realizar pesquisas.');
    if (sub.credits_limit === 0) throw unauthorized('Plano necessario para realizar pesquisas.');
    if (sub.credits_used >= sub.credits_limit) throw unauthorized('Creditos esgotados. Assine um plano para continuar.');
    await query(
      'UPDATE user_subscriptions SET credits_used = credits_used + 1, updated_at = now() WHERE user_id = $1',
      [userId],
    );
  } catch (error: any) {
    if (error?.code === '42P01') {
      throw unauthorized('Plano necessario para realizar pesquisas.');
    }
    throw error;
  }
}

export async function requireUserRecord(userId: string): Promise<UserRow> {
  const user = await findUserById(userId);
  if (!user) throw unauthorized('Sessao invalida.');
  return user;
}
