import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a digit');

export const emailSchema = z.string().trim().toLowerCase().email('Must be a valid email address');

/**
 * Public registration creates PATIENTS only. Doctors and admins are provisioned
 * by an admin, so `role` is deliberately absent - accepting it here would let
 * anyone mint themselves an admin account.
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2, 'Full name is required').max(120),
  phone: z.string().trim().max(32).optional(),
  timezone: z.string().max(64).optional(),
  dateOfBirth: z.coerce.date().max(new Date(), 'Date of birth cannot be in the future').optional(),
  gender: z.string().trim().max(32).optional(),
  bloodGroup: z.string().trim().max(8).optional(),
  allergies: z.string().trim().max(1000).optional(),
  chronicConditions: z.string().trim().max(1000).optional(),
  emergencyContact: z.string().trim().max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateMeSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  timezone: z.string().max(64).optional(),
});
