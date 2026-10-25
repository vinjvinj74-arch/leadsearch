import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { recordAudit } from '../lib/audit.js';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie } from '../lib/cookies.js';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import {
  createSession,
  findUserByEmail,
  findUserById,
  hashPassword,
  newCsrfToken,
  revokeCurrentSession,
  revokeUserSessions,
  toAuthUser,
  verifyPassword,
  type UserRow,
} from '../services/authService.js';
import {
  assertEmailConfigured,
  consumeEmailToken,
  createEmailToken,
  isEmailConfigured,
  sendPasswordResetEmail,
  trySendVerificationEmail,
} from '../services/emailService.js';
import { ensureSettings } from '../services/settingsService.js';
import { logger } from '../lib/logger.js';

export const authRouter = Router();

const emailSchema = z.string().trim().toLowerCase().email('Informe um e-mail valido.').max(254);
const nameSchema = z.string().trim().min(2, 'Informe seu nome.').max(80, 'Nome muito longo.');
const passwordSchema = z
  .string()
  .min(10, 'A senha deve ter pelo menos 10 caracteres.')
  .max(128, 'A senha e muito longa.')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), 'A senha deve conter letras e numeros.');

const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe a senha.').max(128),
});

const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({ token: z.string().min(20), password: passwordSchema });
const verifySchema = z.object({ token: z.string().min(20) });

function setSignedIn(req: Request, response: UserRow) {
  req.user = toAuthUser(response);
}

authRouter.get(
  '/csrf',
  asyncHandler(async (_req, res) => {
    const token = newCsrfToken();
    setCsrfCookie(res, token);
    res.json({ csrfToken: token });
  }),
);

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    let user: UserRow;

    try {
      user = await withTransaction(async (client) => {
        const inserted = await client.query<UserRow>(
          `INSERT INTO users (name, email, password_hash)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [body.name, body.email, passwordHash],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error('Falha ao criar usuario.');
        await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [created.id]);
        return created;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') throw conflict('Ja existe uma conta com este e-mail.');
      throw error;
    }

    await createSession(req, res, user.id);
    setSignedIn(req, user);

    const verificationToken = await createEmailToken(user.id, 'verify_email', 24 * 60);
    if (isEmailConfigured()) {
      void trySendVerificationEmail(user.email, user.name, verificationToken);
    }
    recordAudit(req, 'register', 'user', user.id);
    logger.info({ userId: user.id }, 'Novo usuario cadastrado');

    res.status(201).json({
      user: toAuthUser(user),
      settings: await ensureSettings(user.id),
      emailVerificationSent: isEmailConfigured(),
    });
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await findUserByEmail(body.email);

    if (!user) {
      await hashPassword(body.password);
      throw unauthorized('E-mail ou senha incorretos.');
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        'Muitas tentativas. Tente novamente em alguns minutos ou redefina sua senha.',
      );
    }

    const valid = await verifyPassword(user.password_hash, body.password);
    if (!valid) {
      const updated = await query<{ failed_login_attempts: number; locked_until: Date | null }>(
        `UPDATE users SET
          failed_login_attempts = failed_login_attempts + 1,
          locked_until = CASE WHEN failed_login_attempts + 1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END,
          updated_at = now()
         WHERE id = $1
         RETURNING failed_login_attempts, locked_until`,
        [user.id],
      );
      if ((updated.rows[0]?.failed_login_attempts ?? 0) >= 10) {
        logger.warn({ userId: user.id }, 'Conta bloqueada temporariamente por tentativas de login');
      }
      throw unauthorized('E-mail ou senha incorretos.');
    }

    await query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1',
      [user.id],
    );
    await createSession(req, res, user.id);
    setSignedIn(req, user);
    recordAudit(req, 'login', 'user', user.id);

    res.json({ user: toAuthUser(user), settings: await ensureSettings(user.id) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await revokeCurrentSession(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await findUserById(req.user!.id);
    if (!user) {
      clearSessionCookie(res);
      clearCsrfCookie(res);
      throw unauthorized('Sessao invalida.');
    }
    res.json({
      user: toAuthUser(user),
      settings: await ensureSettings(user.id),
      integrations: {
        googleMapsConfigured: Boolean(config.googleMapsApiKey),
        emailConfigured: isEmailConfigured(),
      },
    });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = forgotSchema.parse(req.body);
    assertEmailConfigured();

    const user = await findUserByEmail(body.email);
    if (user) {
      const token = await createEmailToken(user.id, 'reset_password', 60);
      try {
        await sendPasswordResetEmail(user.email, user.name, token);
        logger.info({ userId: user.id }, 'E-mail de redefinicao solicitado');
      } catch (error) {
        logger.warn({ err: error, userId: user.id }, 'Falha ao enviar e-mail de redefinicao');
      }
    }

    res.json({
      ok: true,
      message: 'Se o e-mail estiver cadastrado, enviaremos as instrucoes de redefinicao.',
    });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = resetSchema.parse(req.body);
    const userId = await consumeEmailToken(body.token, 'reset_password');
    const user = await findUserById(userId);
    if (!user) throw badRequest('Token invalido ou expirado.');

    const passwordHash = await hashPassword(body.password);
    await query('UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [
      userId,
      passwordHash,
    ]);
    await revokeUserSessions(userId);
    req.user = toAuthUser(user);
    recordAudit(req, 'password_reset', 'user', userId);
    clearSessionCookie(res);
    clearCsrfCookie(res);

    res.json({ ok: true, message: 'Senha redefinida. Entre novamente com a nova senha.' });
  }),
);

authRouter.post(
  '/verify-email',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);
    const userId = await consumeEmailToken(body.token, 'verify_email');
    const user = await findUserById(userId);
    if (!user) throw badRequest('Token invalido ou expirado.');
    await query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1', [userId]);
    req.user = toAuthUser(user);
    recordAudit(req, 'email_verified', 'user', userId);
    res.json({ ok: true, message: 'E-mail verificado com sucesso.' });
  }),
);

authRouter.post(
  '/resend-verification',
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    assertEmailConfigured();
    const user = await findUserById(req.user!.id);
    if (!user) throw unauthorized();
    if (user.email_verified_at) throw badRequest('Este e-mail ja foi verificado.');
    const token = await createEmailToken(user.id, 'verify_email', 24 * 60);
    await trySendVerificationEmail(user.email, user.name, token);
    res.json({ ok: true, message: 'Se o SMTP estiver operacional, o e-mail de verificacao foi enviado.' });
  }),
);

export function clearAuthResponse(res: Response): void {
  clearSessionCookie(res);
  clearCsrfCookie(res);
}
