import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid('Must be a valid UUID') });

const MEDICATION_FREQUENCIES = [
  'ONCE_DAILY',
  'TWICE_DAILY',
  'THRICE_DAILY',
  'FOUR_TIMES_DAILY',
  'EVERY_OTHER_DAY',
  'WEEKLY',
  'AS_NEEDED',
];

export const prescriptionItemSchema = z.object({
  medicationName: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(100),
  frequency: z.enum(MEDICATION_FREQUENCIES),
  durationDays: z.number().int().min(1).max(365),
  startDate: z.coerce.date().optional(),
  instructions: z.string().trim().max(300).optional(),
});

export const submitVisitNoteSchema = z.object({
  clinicalNotes: z
    .string()
    .trim()
    .min(10, 'Clinical notes must be at least 10 characters')
    .max(8000),
  diagnosis: z.string().trim().max(500).optional(),
  advice: z.string().trim().max(2000).optional(),
  followUpDate: z.coerce.date().optional(),
  prescriptions: z.array(prescriptionItemSchema).max(20).optional().default([]),
});

export const regenerateSchema = z.object({
  force: z.boolean().optional().default(false),
});
