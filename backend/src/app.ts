import fs from 'fs';
import path from 'path';
import cors from 'cors';
import express from 'express';
import { authenticate, h } from './auth';
import { config } from './config';
import { pool } from './db';
import { errorHandler, notFound } from './errors';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { itemsRouter } from './routes/items';
import { teamsRouter } from './routes/teams';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  if (config.CORS_ORIGIN) app.use(cors({ origin: config.CORS_ORIGIN.split(',') }));

  // Public routes
  app.get(
    '/api/health',
    h(async (_req, res) => {
      try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok' });
      } catch {
        res.status(503).json({ status: 'unavailable' });
      }
    }),
  );
  app.use('/api/auth', authRouter);

  // Everything below requires a valid JWT.
  app.use('/api', authenticate);
  app.use('/api/teams', teamsRouter);
  app.use('/api/items', itemsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api', (_req, _res, next) => next(notFound('Route not found')));

  // Optionally serve the built frontend (used by the Docker image).
  const dist = config.FRONTEND_DIST ? path.resolve(config.FRONTEND_DIST) : null;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
