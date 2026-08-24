import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { env, isProd, activeLlmProvider } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import adminNotificationRoutes from './modules/admin/notifications.routes.js';
import doctorDirectoryRoutes from './modules/doctors/directory.routes.js';
import appointmentRoutes from './modules/appointments/appointments.routes.js';
import summaryRoutes from './modules/summaries/summaries.routes.js';
import calendarRoutes from './modules/calendar/calendar.routes.js';
import clinicRoutes from './modules/clinics/clinics.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // correct client IPs behind Render/Railway proxies

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_BASE_URL,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // Blanket limiter. Auth routes get a tighter one of their own in Part 2.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    })
  );

  // --- health --------------------------------------------------------------
  // Liveness: process is up. Used by hosting platforms.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Readiness: dependencies reachable. Reports degraded subsystems without
  // failing, mirroring how the app itself degrades.
  app.get(
    '/health/ready',
    asyncHandler(async (req, res) => {
      const checks = {};

      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = 'ok';
      } catch (e) {
        checks.database = 'unreachable';
      }

      checks.llmProvider = activeLlmProvider();
      checks.mailTransport = env.MAIL_TRANSPORT;
      checks.googleCalendar = env.GOOGLE_CALENDAR_ENABLED ? 'enabled' : 'disabled';

      const healthy = checks.database === 'ok';
      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ready' : 'degraded',
        checks,
      });
    })
  );

  app.get('/api', (req, res) => {
    res.json({
      name: 'Healthcare Appointment & Follow-up Manager API',
      version: '1.0.0',
      docs: '/api/docs',
    });
  });

  // --- feature routers -----------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/admin/notifications', adminNotificationRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/doctors', doctorDirectoryRoutes);
  app.use('/api/appointments', appointmentRoutes);
  app.use('/api/appointments', summaryRoutes);
  app.use('/api/calendar', calendarRoutes);
  app.use('/api/clinics', clinicRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
