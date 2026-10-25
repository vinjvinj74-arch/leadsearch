import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { recordAudit } from '../lib/audit.js';
import { clearCsrfCookie, clearSessionCookie } from '../lib/cookies.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  findUserById,
  hashPassword,
  revokeUserSessions,
  toAuthUser,
  verifyPassword,
  type UserRow,
} from '../services/authService.js';
import {
  createEmailToken,
  isEmailConfigured,
  trySendVerificationEmail,
} from '../services/emailService.js';
import { ensureSettings, getIntegrationStatus } from '../services/settingsService.js';

export const accountRouter = Router();
accountRouter.use(requireAuth);

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(10, 'A nova senha deve ter pelo menos 10 caracteres.')
    .max(128)
    .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), 'A nova senha deve conter letras e numeros.'),
});

const deleteSchema = z.object({ password: z.string().min(1).max(128) });

accountRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const user = await findUserById(req.user!.id);
    if (!user) throw unauthorized();

    let emailChanged = false;
    if (body.email && body.email !== user.email.toLowerCase()) {
      const existing = await query('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [body.email, user.id]);
      if (existing.rowCount) throw conflict('Este e-mail ja esta em uso.');
      emailChanged = true;
    }

    const updated = await query<UserRow>(
      `UPDATE users SET
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        email_verified_at = CASE WHEN $4 THEN NULL ELSE email_verified_at END,
        updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [user.id, body.name ?? null, body.email ?? null, emailChanged],
    );
    const row = updated.rows[0];
    if (!row) throw notFound('Usuario nao encontrado.');

    if (emailChanged) {
      const token = await createEmailToken(user.id, 'verify_email', 24 * 60);
      if (isEmailConfigured()) {
        void trySendVerificationEmail(body.email!, body.name ?? user.name, token);
      }
      recordAudit(req, 'email_changed', 'user', user.id);
    }
    recordAudit(req, 'profile_updated', 'user', user.id);

    res.json({ user: toAuthUser(row), emailVerificationSent: emailChanged && isEmailConfigured() });
  }),
);

accountRouter.post(
  '/password',
  asyncHandler(async (req, res) => {
    const body = passwordChangeSchema.parse(req.body);
    const user = await findUserById(req.user!.id);
    if (!user) throw unauthorized();
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
      throw badRequest('Senha atual incorreta.');
    }
    const hash = await hashPassword(body.newPassword);
    await query(
      'UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
      [user.id, hash],
    );
    await revokeUserSessions(user.id, req.authSession!.id);
    recordAudit(req, 'password_changed', 'user', user.id);
    res.json({ ok: true, message: 'Senha alterada. Outras sessoes foram encerradas.' });
  }),
);

accountRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const result = await query<{
      id: string;
      user_agent: string | null;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC`,
      [req.user!.id],
    );
    res.json({
      sessions: result.rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        current: row.id === req.authSession!.id,
      })),
    });
  }),
);

accountRouter.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const result = await query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [id, req.user!.id],
    );
    if (!result.rowCount) throw notFound('Sessao nao encontrada.');
    if (id === req.authSession!.id) {
      clearSessionCookie(res);
      clearCsrfCookie(res);
    }
    recordAudit(req, 'session_revoked', 'session', id);
    res.json({ ok: true });
  }),
);

accountRouter.post(
  '/logout-all',
  asyncHandler(async (req, res) => {
    await revokeUserSessions(req.user!.id);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    res.json({ ok: true, message: 'Todas as sessoes foram encerradas.' });
  }),
);

accountRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [user, settings, leads, activities, searches, sources, contacts] = await Promise.all([
      findUserById(userId),
      ensureSettings(userId),
      query('SELECT * FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000', [userId]),
      query('SELECT * FROM lead_activities WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10000', [userId]),
      query('SELECT * FROM searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000', [userId]),
      query(
        `SELECT ls.* FROM lead_sources ls JOIN leads l ON l.id = ls.lead_id WHERE l.user_id = $1 LIMIT 10000`,
        [userId],
      ),
      query(
        `SELECT lc.* FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id WHERE l.user_id = $1 LIMIT 10000`,
        [userId],
      ),
    ]);

    const payload = {
      exportedAt: new Date().toISOString(),
      account: user ? toAuthUser(user) : null,
      settings,
      leads: leads.rows,
      activities: activities.rows,
      searches: searches.rows,
      sources: sources.rows,
      contacts: contacts.rows,
      integrations: getIntegrationStatus(),
    };
    recordAudit(req, 'account_data_exported', 'user', userId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leadsearch-dados-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.send(JSON.stringify(payload, null, 2));
  }),
);

accountRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const body = deleteSchema.parse(req.body);
    const user = await findUserById(req.user!.id);
    if (!user) throw unauthorized();
    if (!(await verifyPassword(user.password_hash, body.password))) {
      throw badRequest('Senha incorreta. A conta nao foi excluida.');
    }
    recordAudit(req, 'account_deleted', 'user', user.id);
    await query('DELETE FROM users WHERE id = $1', [user.id]);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    res.json({ ok: true, message: 'Conta e dados associados excluidos.' });
  }),
);
