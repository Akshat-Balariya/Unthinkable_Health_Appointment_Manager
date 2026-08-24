import { verifyAccessToken } from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { asyncHandler } from './errorHandler.js';

function bearerFrom(req) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/**
 * Verifies the access token and attaches `req.user`.
 *
 * The JWT alone would be enough to authenticate, but we also load the user so a
 * deactivated account stops working immediately rather than at token expiry.
 * Profile ids are attached too, since almost every downstream handler needs the
 * DoctorProfile / PatientProfile id rather than the User id.
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const token = bearerFrom(req);
  if (!token) throw new UnauthorizedError('Missing bearer token');

  const payload = verifyAccessToken(token);

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      role: true,
      fullName: true,
      isActive: true,
      timezone: true,
      doctorProfile: { select: { id: true, isActive: true } },
      patientProfile: { select: { id: true } },
    },
  });

  if (!user) throw new UnauthorizedError('Account no longer exists');
  if (!user.isActive) throw new UnauthorizedError('This account has been deactivated');

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    timezone: user.timezone,
    doctorId: user.doctorProfile?.id ?? null,
    patientId: user.patientProfile?.id ?? null,
  };

  next();
});

/** Route guard: requireRole('ADMIN') or requireRole('DOCTOR', 'ADMIN'). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `This endpoint requires the ${roles.join(' or ')} role`
        )
      );
    }
    next();
  };
}

/**
 * Attaches req.user when a token is present, but does not require one.
 * Used by endpoints that are public yet richer when signed in.
 */
export const optionalAuth = asyncHandler(async (req, res, next) => {
  if (!bearerFrom(req)) return next();
  return requireAuth(req, res, next);
});
