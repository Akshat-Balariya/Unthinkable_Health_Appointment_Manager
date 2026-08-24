import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { runOutboxPass, retryDeadLetters } from '../../jobs/outboxWorker.js';
import { runReminderPass } from '../../jobs/reminderJob.js';
import { audit, auditContext } from '../../lib/audit.js';

const router = Router();
// Platform-admin only. Mounted at its own path (/api/admin/notifications) so
// this blanket guard cannot reject sibling /api/admin routes that clinic admins
// are allowed to use - router.use() applies to every request under the mount
// point, not only to matching routes.
router.use(requireAuth, requireRole('ADMIN'));

/**
 * Operational visibility into the notification queue.
 *
 * A dead-letter queue nobody can see is just a silent failure with extra steps,
 * so DEAD rows are queryable and requeueable from the admin portal.
 */

const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD', 'CANCELLED'];

/** GET /api/admin/notifications/stats */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [byStatus, byType, oldestPending, reminders] = await Promise.all([
      prisma.notificationOutbox.groupBy({ by: ['status'], _count: { status: true } }),
      prisma.notificationOutbox.groupBy({ by: ['type'], _count: { type: true } }),
      prisma.notificationOutbox.findFirst({
        where: { status: { in: ['PENDING', 'FAILED'] } },
        orderBy: { nextAttemptAt: 'asc' },
        select: { nextAttemptAt: true, type: true },
      }),
      prisma.medicationReminder.groupBy({ by: ['status'], _count: { status: true } }),
    ]);

    res.json({
      outbox: {
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count.status])),
        byType: Object.fromEntries(byType.map((r) => [r.type, r._count.type])),
        oldestDue: oldestPending?.nextAttemptAt ?? null,
      },
      medicationReminders: Object.fromEntries(
        reminders.map((r) => [r.status, r._count.status])
      ),
    });
  })
);

/** GET /api/admin/notifications?status=DEAD&type=&page=&limit= */
router.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(OUTBOX_STATUSES).optional(),
      type: z.string().optional(),
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, type, page, limit } = req.validatedQuery;
    const where = { ...(status ? { status } : {}), ...(type ? { type } : {}) };

    const [total, rows] = await prisma.$transaction([
      prisma.notificationOutbox.count({ where }),
      prisma.notificationOutbox.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          status: true,
          recipientEmail: true,
          subject: true,
          attempts: true,
          maxAttempts: true,
          nextAttemptAt: true,
          lastError: true,
          sentAt: true,
          createdAt: true,
          appointmentId: true,
        },
      }),
    ]);

    res.json({
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

/**
 * POST /api/admin/notifications/retry
 * Requeues dead letters. Manual by design: a DEAD row usually means something
 * needs fixing first, so automatic retry would just re-fail on a schedule.
 */
router.post(
  '/retry',
  validate({
    body: z.object({
      ids: z.array(z.string().uuid()).max(500).optional(),
      type: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const count = await retryDeadLetters(req.body);
    await audit({
      ...auditContext(req),
      action: 'notifications.dead_letters_retried',
      entityType: 'NotificationOutbox',
      entityId: 'bulk',
      metadata: { count, filter: req.body },
    });
    res.json({ requeued: count });
  })
);

/** POST /api/admin/notifications/drain - run one pass now instead of waiting */
router.post(
  '/drain',
  validate({ body: z.object({ batchSize: z.number().int().min(1).max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const reminders = await runReminderPass({ batchSize: 100 });
    const outbox = await runOutboxPass({ batchSize: req.body.batchSize ?? 25 });
    res.json({ reminders, outbox });
  })
);

export default router;
