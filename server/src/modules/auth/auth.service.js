import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { ConflictError, UnauthorizedError, NotFoundError } from '../../lib/errors.js';
import { issueTokenPair, revokeAllForUser } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';

/** Shape returned to clients. Never leaks passwordHash. */
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    phone: user.phone ?? null,
    timezone: user.timezone,
    createdAt: user.createdAt,
  };
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

/**
 * Registers a patient. User + PatientProfile are created in one transaction so
 * a failure cannot leave a patient account without its profile row.
 */
export async function registerPatient(input, ctx = {}) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new ConflictError('An account with that email already exists');

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: 'PATIENT',
        fullName: input.fullName,
        phone: input.phone,
        ...(input.timezone ? { timezone: input.timezone } : {}),
        patientProfile: {
          create: {
            dateOfBirth: input.dateOfBirth ?? null,
            gender: input.gender ?? null,
            bloodGroup: input.bloodGroup ?? null,
            allergies: input.allergies ?? null,
            chronicConditions: input.chronicConditions ?? null,
            emergencyContact: input.emergencyContact ?? null,
          },
        },
      },
    });
    return created;
  });

  await audit({
    ...ctx,
    actorUserId: user.id,
    action: 'auth.register',
    entityType: 'User',
    entityId: user.id,
    metadata: { role: 'PATIENT' },
  });

  const tokens = await issueTokenPair(user);
  return { user: publicUser(user), tokens };
}

export async function login({ email, password }, ctx = {}) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Compare against a dummy hash when the user is absent so that response time
  // does not reveal whether an email is registered.
  const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) throw new UnauthorizedError('Incorrect email or password');
  if (!user.isActive) throw new UnauthorizedError('This account has been deactivated');

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await audit({
    ...ctx,
    actorUserId: user.id,
    action: 'auth.login',
    entityType: 'User',
    entityId: user.id,
  });

  const tokens = await issueTokenPair(user);
  return { user: publicUser(user), tokens };
}

/** Full profile for the signed-in user, including the role-specific part. */
export async function getMe(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      patientProfile: true,
      doctorProfile: {
        include: { workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] } },
      },
    },
  });
  if (!user) throw new NotFoundError('User');

  return {
    ...publicUser(user),
    ...(user.patientProfile ? { patientProfile: user.patientProfile } : {}),
    ...(user.doctorProfile ? { doctorProfile: user.doctorProfile } : {}),
  };
}

export async function updateMe(userId, patch) {
  const user = await prisma.user.update({ where: { id: userId }, data: patch });
  return publicUser(user);
}

/** Changing the password kills every existing session. */
export async function changePassword(userId, { currentPassword, newPassword }, ctx = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new UnauthorizedError('Current password is incorrect');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await revokeAllForUser(userId);

  await audit({
    ...ctx,
    action: 'auth.password_changed',
    entityType: 'User',
    entityId: userId,
  });
}
