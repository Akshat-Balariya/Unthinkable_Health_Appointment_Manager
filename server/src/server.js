import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma, disconnectPrisma } from './lib/prisma.js';
import { startHoldSweeper } from './jobs/holdSweeper.js';
import { startSummaryWorker } from './jobs/summaryJob.js';
import { startOutboxWorker } from './jobs/outboxWorker.js';
import { startReminderWorker } from './jobs/reminderJob.js';

const log = logger.child('server');

async function start() {
  // Verify the database before accepting traffic - a server that answers 200 on
  // /health while every real request 500s is worse than one that fails to boot.
  try {
    await prisma.$connect();
    log.info('database connected');
  } catch (e) {
    log.error('cannot reach database - check DATABASE_URL', { message: e.message });
    process.exit(1);
  }

  // In-process sweeper. In a multi-instance deployment this is still safe:
  // expireStaleHolds is an idempotent conditional UPDATE, so concurrent
  // sweepers cannot corrupt each other.
  const stopSweeper = startHoldSweeper({ intervalMs: 60_000 });

  // LLM generation runs out of band: the provider takes 4-14s on a good day,
  // which no user-facing request should ever wait on.
  // Background jobs run in-process by default so a single free-tier dyno is
  // enough. `npm run worker` runs the identical set as its own process; both
  // may run at once, because every job claims work with a conditional UPDATE.
  const stopJobs = env.WORKER_ENABLED
    ? [
        startSummaryWorker({ intervalMs: env.WORKER_POLL_INTERVAL_MS, batchSize: 5 }),
        startOutboxWorker({
          intervalMs: env.WORKER_POLL_INTERVAL_MS,
          batchSize: env.WORKER_BATCH_SIZE,
        }),
        startReminderWorker({ intervalMs: 60_000 }),
      ]
    : [];

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info(`listening on http://localhost:${env.PORT}`, { env: env.NODE_ENV });
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    stopSweeper();
    stopJobs.forEach((stop) => stop());
    server.close(async () => {
      await disconnectPrisma();
      log.info('shutdown complete');
      process.exit(0);
    });
    // Don't hang forever on lingering connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { reason: String(reason) });
  });
}

start();
