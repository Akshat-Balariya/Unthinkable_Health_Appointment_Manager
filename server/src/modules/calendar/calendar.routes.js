import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import { ValidationError, AppError } from '../../lib/errors.js';
import { audit, auditContext } from '../../lib/audit.js';
import { authUrl, exchangeCode, disconnect, calendarEnabled } from '../../lib/google/calendar.js';
import { runCalendarPass } from '../../jobs/calendarJob.js';

const router = Router();

/** GET /api/calendar/status */
router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = await prisma.calendarAccount.findUnique({
      where: { userId: req.user.id },
      select: { provider: true, calendarId: true, connectedAt: true, scope: true, lastError: true },
    });
    res.json({
      enabled: calendarEnabled(),
      connected: Boolean(account),
      account: account ?? null,
    });
  })
);

/**
 * GET /api/calendar/google/connect
 * Returns the consent URL rather than redirecting, so an XHR-based frontend can
 * open it itself instead of fighting a cross-origin redirect.
 */
router.get(
  '/google/connect',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!calendarEnabled()) {
      throw new AppError('Google Calendar is not configured on this server', {
        status: 503,
        code: 'CALENDAR_DISABLED',
      });
    }
    res.json({ authUrl: authUrl(req.user.id) });
  })
);

/**
 * GET /api/calendar/google/callback
 *
 * Google redirects the browser here, so there is no bearer token - the user is
 * identified by the `state` parameter minted at connect time. Always redirects
 * back to the client rather than rendering, so the user lands in the app.
 */
router.get(
  '/google/callback',
  validate({
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.validatedQuery;
    const back = (status) => `${env.CLIENT_BASE_URL}/calendar/connected?status=${status}`;

    if (error) return res.redirect(back(`denied`));
    if (!code || !state) return res.redirect(back('invalid'));

    const user = await prisma.user.findUnique({ where: { id: state }, select: { id: true } });
    if (!user) return res.redirect(back('invalid'));

    try {
      await exchangeCode(code, user.id);
      await audit({
        actorUserId: user.id,
        action: 'calendar.connected',
        entityType: 'CalendarAccount',
        entityId: user.id,
      });

      // Backfill any events queued while the user was not connected.
      await prisma.calendarEvent.updateMany({
        where: { userId: user.id, status: { in: ['SYNCED', 'FAILED'] }, externalEventId: null },
        data: { status: 'PENDING', attempts: 0, lastError: null },
      });

      return res.redirect(back('connected'));
    } catch (e) {
      return res.redirect(back('failed'));
    }
  })
);

/** DELETE /api/calendar/google - revoke and forget */
router.delete(
  '/google',
  requireAuth,
  asyncHandler(async (req, res) => {
    const removed = await disconnect(req.user.id);
    await audit({
      ...auditContext(req),
      action: 'calendar.disconnected',
      entityType: 'CalendarAccount',
      entityId: req.user.id,
    });
    res.json({ disconnected: removed });
  })
);

/** POST /api/calendar/sync - run a pass now instead of waiting for the worker */
router.post(
  '/sync',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await runCalendarPass({ batchSize: 25 }));
  })
);

export default router;
