import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { availabilityQuery } from '../appointments/appointments.schemas.js';
import { NotFoundError } from '../../lib/errors.js';
import { getAvailability } from '../appointments/slots.service.js';

const router = Router();

/**
 * Patient-facing doctor directory.
 *
 * Deliberately separate from the admin router: it exposes only what a patient
 * needs to choose a doctor, and never surfaces inactive doctors, licence
 * numbers, or the doctor's own email address.
 */

const searchQuery = z.object({
  specialisation: z.string().trim().max(120).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

function shapePublic(d) {
  return {
    id: d.id,
    fullName: d.user.fullName,
    specialisation: d.specialisation,
    qualifications: d.qualifications,
    bio: d.bio,
    consultationFee: Number(d.consultationFee),
    slotDurationMin: d.slotDurationMin,
    maxAdvanceDays: d.maxAdvanceDays,
    workingHours: (d.workingHours ?? [])
      .filter((w) => w.isActive)
      .map((w) => ({ dayOfWeek: w.dayOfWeek, startTime: w.startTime, endTime: w.endTime })),
  };
}

/** GET /api/doctors/specialisations - distinct list, for the search filter */
router.get(
  '/specialisations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.doctorProfile.groupBy({
      by: ['specialisation'],
      where: { isActive: true, user: { isActive: true } },
      _count: { specialisation: true },
      orderBy: { specialisation: 'asc' },
    });
    res.json(
      rows.map((r) => ({ specialisation: r.specialisation, doctorCount: r._count.specialisation }))
    );
  })
);

/** GET /api/doctors?specialisation=Cardiology&q=rao */
router.get(
  '/',
  requireAuth,
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => {
    const { specialisation, q, page, limit } = req.validatedQuery;

    const where = {
      isActive: true,
      user: { isActive: true },
      ...(specialisation
        ? { specialisation: { equals: specialisation, mode: 'insensitive' } }
        : {}),
      ...(q
        ? {
            OR: [
              { user: { fullName: { contains: q, mode: 'insensitive' } } },
              { specialisation: { contains: q, mode: 'insensitive' } },
              { qualifications: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.doctorProfile.count({ where }),
      prisma.doctorProfile.findMany({
        where,
        include: {
          user: { select: { fullName: true } },
          workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
        },
        orderBy: { specialisation: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      data: rows.map(shapePublic),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

/** GET /api/doctors/:id */
router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: req.params.id, isActive: true, user: { isActive: true } },
      include: {
        user: { select: { fullName: true } },
        workingHours: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      },
    });
    if (!doctor) throw new NotFoundError('Doctor');

    // Upcoming leave is public so a patient understands why days are missing.
    const leaves = await prisma.doctorLeave.findMany({
      where: { doctorId: doctor.id, leaveDate: { gte: new Date() } },
      select: { leaveDate: true, startTime: true, endTime: true },
      orderBy: { leaveDate: 'asc' },
      take: 60,
    });

    res.json({ ...shapePublic(doctor), upcomingLeaves: leaves });
  })
);

/**
 * GET /api/doctors/:id/availability?from=&to=  (or ?date=)
 *
 * Computed live from working hours minus leave minus existing bookings. These
 * slots are advisory only - another patient may take one before this caller
 * holds it, which is exactly what the 409 from POST /appointments/hold means.
 */
router.get(
  '/:id/availability',
  requireAuth,
  validate({
    params: z.object({ id: z.string().uuid() }),
    query: availabilityQuery,
  }),
  asyncHandler(async (req, res) => {
    const { date, from, to } = req.validatedQuery;
    const availability = await getAvailability(req.params.id, {
      from: date ?? from,
      to: date ?? to,
    });
    res.json(availability);
  })
);

export default router;
