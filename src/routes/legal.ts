import path from 'node:path';
import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_DOCUMENTS,
  LEGAL_VERSION,
  REQUIRED_REGISTRATION_DOCUMENTS,
} from '../legal/versions.js';
import { requireAuth } from '../middleware/auth.js';

const publicDirectory = path.resolve(process.cwd(), 'public');

const legalPages: Record<string, string> = {
  '/termos': 'termos.html',
  '/privacidade': 'privacidade.html',
  '/lgpd': 'lgpd.html',
  '/politicas': 'politicas.html',
  '/politicas/cookies': 'politicas/cookies.html',
  '/politicas/seguranca': 'politicas/seguranca.html',
  '/politicas/uso-aceitavel': 'politicas/uso-aceitavel.html',
  '/politicas/reembolso': 'refund-policy.html',
  '/exclusao-de-dados': 'data-deletion.html',
  '/contato': 'contact.html',
  '/terms': 'termos.html',
  '/privacy': 'privacidade.html',
  '/lgpd-rights': 'lgpd.html',
  '/cookies': 'politicas/cookies.html',
  '/security-policy': 'politicas/seguranca.html',
  '/acceptable-use': 'politicas/uso-aceitavel.html',
  '/refund-policy': 'refund-policy.html',
  '/data-deletion': 'data-deletion.html',
  '/contact': 'contact.html',
};

export const legalPagesRouter = Router();

for (const [route, file] of Object.entries(legalPages)) {
  legalPagesRouter.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(publicDirectory, file));
  });
}

export const legalApiRouter = Router();

legalApiRouter.get('/documents', (_req, res) => {
  res.json({
    version: LEGAL_VERSION,
    controller: 'RADAR',
    contact: LEGAL_CONTACT_EMAIL,
    requiredOnRegistration: REQUIRED_REGISTRATION_DOCUMENTS,
    documents: LEGAL_DOCUMENTS,
  });
});

legalApiRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await query<{
      document: string;
      version: string;
      accepted_at: Date;
    }>(
      `SELECT document, version, accepted_at
       FROM user_consents
       WHERE user_id = $1
       ORDER BY accepted_at DESC`,
      [req.user!.id],
    );

    res.json({
      version: LEGAL_VERSION,
      controller: 'RADAR',
      contact: LEGAL_CONTACT_EMAIL,
      documents: LEGAL_DOCUMENTS,
      accepted: result.rows.map((row) => ({
        document: row.document,
        version: row.version,
        acceptedAt: row.accepted_at.toISOString(),
      })),
    });
  }),
);
