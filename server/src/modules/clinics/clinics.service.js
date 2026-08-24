import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { hashPassword, publicUser } from '../auth/auth.service.js';
import { issueTokenPair } from '../../lib/tokens.js';
import { audit } from '../../lib/audit.js';

/** "Sunrise Family Clinic" -> "sunrise-family-clinic" */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function uniqueSlug(base) {
  const root = base || 'clinic';
  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await prisma.clinic.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
}

/**
 * Self-service clinic registration.
 *
 * Creates the Clinic and its first CLINIC_ADMIN in one transaction - a clinic
 * with no way to sign in would be unusable, and an admin with no clinic would
 * have nothing to scope against.
 *
 * The role is hardcoded to CLINIC_ADMIN and never read from the request, so this
 * endpoint cannot be used to mint a platform ADMIN.
 */
export async function registerClinic(input, ctx = {}) {
  const [clinicTaken, userTaken] = await Promise.all([
    prisma.clinic.findUnique({ where: { email: input.clinicEmail } }),
    prisma.user.findUnique({ where: { email: input.adminEmail } }),
  ]);
  if (clinicTaken) throw new ConflictError('A clinic with that email is already registered');
  if (userTaken) throw new ConflictError('An account with that email already exists');

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(slugify(input.name));

  const { clinic, user } = await prisma.$transaction(async (tx) => {
    const created = await tx.clinic.create({
      data: {
        name: input.name,
        slug,
        email: input.clinicEmail,
        phone: input.phone ?? null,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });

    const admin = await tx.user.create({
      data: {
        email: input.adminEmail,
        passwordHash,
        role: 'CLINIC_ADMIN',
        fullName: input.adminName,
        phone: input.phone ?? null,
        clinicId: created.id,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });

    return { clinic: created, user: admin };
  });

  await audit({
    ...ctx,
    actorUserId: user.id,
    action: 'clinic.registered',
    entityType: 'Clinic',
    entityId: clinic.id,
    metadata: { name: clinic.name, slug: clinic.slug },
  });

  const tokens = await issueTokenPair(user);
  return { clinic, user: publicUser(user), tokens };
}

export async function getClinic(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: { _count: { select: { doctors: true, admins: true } } },
  });
  if (!clinic) throw new NotFoundError('Clinic');
  const { _count, ...rest } = clinic;
  return { ...rest, doctorCount: _count.doctors, adminCount: _count.admins };
}

export async function updateClinic(clinicId, patch, ctx = {}) {
  const clinic = await prisma.clinic.update({ where: { id: clinicId }, data: patch });
  await audit({
    ...ctx,
    action: 'clinic.updated',
    entityType: 'Clinic',
    entityId: clinicId,
    metadata: { fields: Object.keys(patch) },
  });
  return clinic;
}

/** Public list, used by the patient-facing directory filter. */
export async function listClinics() {
  const rows = await prisma.clinic.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      city: true,
      _count: { select: { doctors: true } },
    },
    orderBy: { name: 'asc' },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    city: c.city,
    doctorCount: c._count.doctors,
  }));
}
