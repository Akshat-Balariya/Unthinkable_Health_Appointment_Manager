/**
 * Standalone background worker.
 *
 *   npm run worker
 *
 * The same jobs also run in-process inside the API server when WORKER_ENABLED
 * is true, which is what free hosting tiers need - one dyno, no separate
 * worker. Running this as its own process is the better shape once there is
 * more than one API instance: slow LLM calls and SMTP round-trips stop
 * competing with request handling for the event loop.
 *
 * Both modes are safe simultaneously. Every job claims its work with a
 * conditional UPDATE (FOR UPDATE SKIP LOCKED for the outbox, status guards
 * elsewhere), so duplicate workers divide the queue rather than duplicating it.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma, disconnectPrisma } from '../lib/prisma.js';
import { startOutboxWorker } from './outboxWorker.js';
import { startReminderWorker } from './reminderJob.js';
import { startSummaryWorker } from './summaryJob.js';
import { startHoldSweeper } from './holdSweeper.js';
import { startCalendarWorker } from './calendarJob.js';

const log = logger.child('worker');

async function main() {
  try {
    await prisma.$connect();
    log.info('database connected');
  } catch (e) {
    log.error('cannot reach database', { message: e.message });
    process.exit(1);
  }

  const stops = [
    startOutboxWorker({
      intervalMs: env.WORKER_POLL_INTERVAL_MS,
      batchSize: env.WORKER_BATCH_SIZE,
    }),
    startReminderWorker({ intervalMs: 60_000 }),
    startSummaryWorker({ intervalMs: env.WORKER_POLL_INTERVAL_MS }),
    startHoldSweeper({ intervalMs: 60_000 }),
    startCalendarWorker({ intervalMs: 30_000 }),
  ];

  log.info('worker running', {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    batchSize: env.WORKER_BATCH_SIZE,
    mailTransport: env.MAIL_TRANSPORT,
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received, stopping jobs`);
    stops.forEach((stop) => stop());
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection in worker', { reason: String(reason) });
  });

  // Keep the process alive; every job timer is unref'd.
  setInterval(() => {}, 1 << 30);
}

main();
