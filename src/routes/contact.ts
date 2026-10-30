import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/http.js';
import { contactLimiter } from '../middleware/rateLimit.js';

export const contactRouter = Router();

const CONTACT_KINDS = ['support', 'privacy', 'data_deletion', 'commercial', 'security'] as const;

const contactSchema = z.object({
  kind: z.enum(CONTACT_KINDS).default('support'),
  name: z.string().trim().min(2, 'Informe seu nome.').max(120),
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido.').max(254),
  message: z.string().trim().min(10, 'Descreva sua solicitação com pelo menos 10 caracteres.').max(4000),
  acceptPrivacy: z.literal(true, {
    errorMap: () => ({ message: 'É necessário aceitar a Política de Privacidade.' }),
  }),
});

function referenceCode(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return `RADAR-${date}-${random}`;
}

contactRouter.post(
  '/',
  contactLimiter,
  asyncHandler(async (req, res) => {
    const body = contactSchema.parse(req.body);
    const reference = referenceCode();

    await query(
      `INSERT INTO contact_requests
        (reference_code, kind, name, email, message, user_id, ip_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        reference,
        body.kind,
        body.name,
        body.email,
        body.message,
        req.user?.id ?? null,
        req.clientIpHash ?? null,
        JSON.stringify({ userAgent: (req.get('user-agent') ?? '').slice(0, 300) }),
      ],
    );

    recordAudit(req, 'contact_request_created', 'contact_request', reference, {
      kind: body.kind,
      email: body.email,
    });

    res.status(201).json({
      ok: true,
      reference,
      message:
        'Solicitação registrada. Guarde o código de protocolo e acompanhe a resposta pelo e-mail informado.',
    });
  }),
);
