import { z } from 'zod';
import { passwordSchema, emailSchema } from '../auth/auth.schemas.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timeString = z
  .string()
  .trim()
  .regex(HHMM, 'Time must be in 24-hour HH:mm format, e.g. "09:30"');

/** "09:30" -> 570 */
export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const workingHourBlock = z
  .object({
    dayOfWeek: z.number().int().min(0, '0 = Sunday').max(6, '6 = Saturday'),
    startTime: timeString,
    endTime: timeString,
    isActive: z.boolean().optional().default(true),
  })
  .refine((b) => toMinutes(b.endTime) > toMinutes(b.startTime), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

/**
 * Blocks on the same day must not overlap - otherwise slot generation would
 * emit the same slot twice and the booking guard would reject legitimate
 * bookings at runtime instead of here, where the mistake is visible.
 */
export const workingHoursArray = z
  .array(workingHourBlock)
  .max(28, 'At most 28 working-hour blocks')
  .superRefine((blocks, ctx) => {
    const byDay = new Map();
    blocks.forEach((b, i) => {
      if (!byDay.has(b.dayOfWeek)) byDay.set(b.dayOfWeek, []);
      byDay.get(b.dayOfWeek).push({ ...b, i });
    });

    for (const [day, list] of byDay) {
      const sorted = [...list].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
      for (let k = 1; k < sorted.length; k += 1) {
        if (toMinutes(sorted[k].startTime) < toMinutes(sorted[k - 1].endTime)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [sorted[k].i, 'startTime'],
            message:
              `Overlaps the ${sorted[k - 1].startTime}-${sorted[k - 1].endTime} block ` +
              `on day ${day}`,
          });
        }
      }
    }
  });

const schedulingConfig = {
  slotDurationMin: z.number().int().min(5).max(240).optional(),
  bufferMin: z.number().int().min(0).max(120).optional(),
  maxAdvanceDays: z.number().int().min(1).max(365).optional(),
  minNoticeMin: z.number().int().min(0).max(10080).optional(),
};

export const createDoctorSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(32).optional(),
  timezone: z.string().max(64).optional(),

  specialisation: z.string().trim().min(2).max(120),
  qualifications: z.string().trim().max(240).optional(),
  bio: z.string().trim().max(2000).optional(),
  licenseNumber: z.string().trim().max(64).optional(),
  consultationFee: z.number().nonnegative().max(1_000_000).optional(),
  ...schedulingConfig,

  workingHours: workingHoursArray.optional().default([]),
});

export const updateDoctorSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    specialisation: z.string().trim().min(2).max(120).optional(),
    qualifications: z.string().trim().max(240).nullable().optional(),
    bio: z.string().trim().max(2000).nullable().optional(),
    licenseNumber: z.string().trim().max(64).nullable().optional(),
    consultationFee: z.number().nonnegative().max(1_000_000).optional(),
    isActive: z.boolean().optional(),
    ...schedulingConfig,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const replaceWorkingHoursSchema = z.object({
  workingHours: workingHoursArray,
});

/**
 * A leave is whole-day unless BOTH times are supplied. Accepting only one would
 * be ambiguous, so it is rejected.
 */
export const createLeaveSchema = z
  .object({
    leaveDate: z.coerce.date(),
    startTime: timeString.optional(),
    endTime: timeString.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.startTime === undefined) === (v.endTime === undefined), {
    message: 'Provide both startTime and endTime for a partial-day leave, or neither for a full day',
    path: ['startTime'],
  })
  // Both guards are needed: Zod runs every .refine in the chain even after an
  // earlier one fails, so this must tolerate a missing endTime rather than
  // calling toMinutes(undefined) and throwing a TypeError.
  .refine((v) => !v.startTime || !v.endTime || toMinutes(v.endTime) > toMinutes(v.startTime), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export const listDoctorsQuery = z.object({
  specialisation: z.string().trim().optional(),
  q: z.string().trim().max(120).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const idParam = z.object({ id: z.string().uuid('Must be a valid UUID') });
export const doctorLeaveParams = z.object({
  id: z.string().uuid(),
  leaveId: z.string().uuid(),
});
