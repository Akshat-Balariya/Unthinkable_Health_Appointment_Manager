import { expireStaleHolds } from '../modules/appointments/booking.service.js';
import { logger } from '../lib/logger.js';

const log = logger.child('sweeper');

/**
 * Releases slot holds whose TTL has lapsed.
 *
 * This is a safety net, not the primary mechanism. `holdSlot` already reaps the
 * specific slot it is about to write, so a lapsed hold never blocks a booking
 * even if this sweeper is down. What the sweeper adds is hygiene: without it,
 * abandoned holds would linger as HELD forever, making availability listings
 * wrong and the concurrent-hold quota unreleasable.
 *
 * Holds move to EXPIRED rather than being deleted, so an abandoned booking
 * funnel is still visible in the data.
 */
export function startHoldSweeper({ intervalMs = 60_000 } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap with a slow previous run
    running = true;
    try {
      const count = await expireStaleHolds();
      if (count > 0) log.info('released lapsed holds', { count });
    } catch (e) {
      // A failed sweep is recoverable - the next tick retries.
      log.error('sweep failed', { error: e.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keep the process alive on this alone
  tick();

  log.info('hold sweeper started', { intervalMs });
  return () => clearInterval(timer);
}
