import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Appends an audit row. Never throws - a failed audit write must not roll back
 * the business operation it was describing. Pass `tx` to make it part of an
 * enclosing transaction where the audit trail genuinely must be atomic.
 */
export async function audit(
  { actorUserId = null, action, entityType, entityId, metadata = null, ipAddress = null },
  tx = prisma
) {
  try {
    await tx.auditLog.create({
      data: { actorUserId, action, entityType, entityId, metadata, ipAddress },
    });
  } catch (e) {
    logger.warn('audit write failed', { action, entityType, entityId, error: e.message });
  }
}

/** Pulls the caller's identity and IP off an Express request. */
export function auditContext(req) {
  return { actorUserId: req.user?.id ?? null, ipAddress: req.ip ?? null };
}
