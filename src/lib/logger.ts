import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  base: { service: 'leadsearch', env: config.env },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'password',
      'newPassword',
      'currentPassword',
      'token',
      'apiKey',
      'SMTP_PASS',
      'DATABASE_URL',
      'req.headers.x-api-key',
    ],
    censor: '[REDACTED]',
  },
});
