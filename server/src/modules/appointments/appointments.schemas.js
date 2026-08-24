import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid('Must be a valid UUID') });

export const availabilityQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  date: z.coerce.date().optional(), // convenience: a single day
});

export const holdSlotSchema = z.object({
  doctorId: z.string().uuid(),
  slotStart: z.coerce.date(),
  reasonForVisit: z.string().trim().max(500).optional(),
});

/**
 * The symptom form. `symptomsText` is the LLM's only required input, so it is
 * bounded on both ends: too short produces a useless summary, too long blows
 * the context window and the cost per call.
 */
export const confirmBookingSchema = z.object({
  symptomsText: z
    .string()
    .trim()
    .min(10, 'Please describe your symptoms in a little more detail')
    .max(4000),
  durationDays: z.number().int().min(0).max(3650).optional(),
  severity: z.number().int().min(1).max(10).optional(),
  existingConditions: z.string().trim().max(2000).optional(),
  currentMedications: z.string().trim().max(2000).optional(),
  additionalNotes: z.string().trim().max(2000).optional(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const rescheduleSchema = z.object({
  newSlotStart: z.coerce.date(),
  reason: z.string().trim().max(500).optional(),
});

const APPOINTMENT_STATUSES = [
  'HELD',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
  'EXPIRED',
];

export const listAppointmentsQuery = z.object({
  status: z
    .union([z.enum(APPOINTMENT_STATUSES), z.array(z.enum(APPOINTMENT_STATUSES))])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  upcoming: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
