import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { leadsRouter } from './routes/leads.js';
import { radarRouter } from './routes/radar.js';
import { searchesRouter } from './routes/searches.js';
import { integrationsRouter, settingsRouter } from './routes/settings.js';
import { healthRouter, systemRouter } from './routes/system.js';
import { attachSession } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { corsMiddleware, helmetMiddleware, requestContext } from './middleware/security.js';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());
  app.use(attachSession);

  app.use('/api/health', healthRouter);
  app.use('/api', apiLimiter);
  app.use('/api', csrfProtection);

  app.use('/api/auth', authRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/searches', searchesRouter);
  app.use('/api/radar', radarRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint nao encontrado.' } });
  });

  const rootDir = process.cwd();
  const publicDir = path.join(rootDir, 'public');
  const indexFile = path.join(rootDir, 'index.html');
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
  app.get(['/', '/index.html'], (_req, res) => {
    res.sendFile(indexFile);
  });
  app.get('*', (req, res, next) => {
    if (req.path.includes('.')) {
      next();
      return;
    }
    res.sendFile(indexFile);
  });

  app.use((_req, res) => {
    res.status(404).send('Nao encontrado');
  });
  app.use(errorHandler);

  return app;
}
