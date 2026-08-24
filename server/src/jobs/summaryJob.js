import { prisma } from '../lib/prisma.js';
import {
  generatePreVisitSummary,
  generatePostVisitSummary,
} from '../modules/summaries/summaries.service.js';
import { logger } from '../lib/logger.js';

const log = logger.child('summary-job');

/** Retries slow down as attempts mount, so a dead provider is not hammered. */
function isDue(row) {
  if (row.attempts === 0) return true;
  const backoffMinutes = Math.min(2 ** (row.attempts - 1), 60);
  const lastTouch = row.updatedAt ?? row.createdAt;
  return Date.now() - new Date(lastTouch).getTime() >= backoffMinutes * 60_000;
}

/**
 * Drains PENDING summaries.
 *
 * Generation happens here rather than in the request that created the row for
 * two reasons: the provider takes 4-14 seconds on a good day (and 129s on a bad
 * one), and a failure must not roll back the booking or the visit note that
 * triggered it.
 *
 * Rows are processed one at a time. Free-tier LLM quotas are per-minute, so
 * parallelism here buys nothing and reliably triggers 429s.
 */
export async function runSummaryPass({ batchSize = 5 } = {}) {
  let processed = 0;
  let succeeded = 0;

  const [pendingPre, pendingPost] = await Promise.all([
    prisma.preVisitSummary.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { appointmentId: true, attempts: true, updatedAt: true, createdAt: true },
    }),
    prisma.postVisitSummary.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: { appointmentId: true, attempts: true, updatedAt: true, createdAt: true },
    }),
  ]);

  for (const row of pendingPre.filter(isDue)) {
    processed += 1;
    try {
      const r = await generatePreVisitSummary(row.appointmentId);
      if (r.status === 'READY') succeeded += 1;
    } catch (e) {
      // generatePreVisitSummary already records failure on the row; anything
      // reaching here is unexpected and must not kill the pass.
      log.error('unexpected pre-visit failure', {
        appointmentId: row.appointmentId,
        error: e.message,
      });
    }
  }

  for (const row of pendingPost.filter(isDue)) {
    processed += 1;
    try {
      const r = await generatePostVisitSummary(row.appointmentId);
      if (r.status === 'READY') succeeded += 1;
    } catch (e) {
      log.error('unexpected post-visit failure', {
        appointmentId: row.appointmentId,
        error: e.message,
      });
    }
  }

  if (processed > 0) log.info('summary pass complete', { processed, succeeded });
  return { processed, succeeded };
}

/** Periodic runner. Never overlaps itself. */
export function startSummaryWorker({ intervalMs = 20_000, batchSize = 5 } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSummaryPass({ batchSize });
    } catch (e) {
      log.error('summary pass failed', { error: e.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  log.info('summary worker started', { intervalMs, batchSize });
  return () => clearInterval(timer);
}
