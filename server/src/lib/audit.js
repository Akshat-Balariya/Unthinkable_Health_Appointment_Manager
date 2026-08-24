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

/**
 * Request context threaded into every service call: who is acting, from where,
 * and which clinic they are confined to.
 *
 * `clinicId` is the tenancy scope. It is populated ONLY for CLINIC_ADMIN, so a
 * platform ADMIN gets null and is deliberately unscoped. Taking it from the
 * verified token rather than the request body is what makes the scoping
 * trustworthy - a clinic cannot widen its own reach by sending a different id.
 */
export function auditContext(req) {
  return {
    actorUserId: req.user?.id ?? null,
    ipAddress: req.ip ?? null,
    clinicId: req.user?.role === 'CLINIC_ADMIN' ? (req.user.clinicId ?? null) : null,
  };
}
