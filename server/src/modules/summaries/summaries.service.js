import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { generateStructured } from '../../lib/llm/index.js';
import { buildPreVisitPrompt, buildPostVisitPrompt } from '../../lib/llm/prompts.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

const log = logger.child('summaries');

/**
 * LLM generation is ALWAYS a side effect, never a precondition.
 *
 * Every function here returns a status object rather than throwing on provider
 * failure. A booking that succeeded must not be undone because a third-party
 * model was rate-limited, and a doctor must still be able to see the raw symptom
 * text when the summary is unavailable.
 *
 * Failure is recorded on the row itself (status/attempts/lastError) so the UI
 * can distinguish "not generated yet" from "we tried five times and gave up".
 */

/** How many times a summary is retried before it is parked as FAILED. */
const MAX_SUMMARY_ATTEMPTS = 5;

/**
 * Generates the doctor-facing pre-visit summary.
 *
 * Safe to call repeatedly: a summary already READY is returned untouched, so a
 * retrying worker cannot burn quota regenerating finished work.
 */
export async function generatePreVisitSummary(appointmentId, { force = false } = {}) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { symptomReport: true, preVisitSummary: true },
  });

  if (!appointment) throw new NotFoundError('Appointment');
  if (!appointment.symptomReport) {
    return { status: 'SKIPPED', reason: 'No symptom report was submitted' };
  }
  if (appointment.preVisitSummary?.status === 'READY' && !force) {
    return { status: 'READY', cached: true };
  }

  const attempts = (appointment.preVisitSummary?.attempts ?? 0) + 1;
  const prompt = buildPreVisitPrompt(appointment.symptomReport);

  try {
    const { data, meta } = await generateStructured(prompt);

    await prisma.preVisitSummary.upsert({
      where: { appointmentId },
      update: {
        status: 'READY',
        urgencyLevel: data.urgencyLevel,
        chiefComplaint: data.chiefComplaint,
        suggestedQuestions: data.suggestedQuestions,
        provider: meta.provider,
        model: meta.model,
        promptVersion: meta.promptVersion,
        rawResponse: meta.rawResponse,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
        attempts,
        lastError: null,
        generatedAt: new Date(),
      },
      create: {
        appointmentId,
        status: 'READY',
        urgencyLevel: data.urgencyLevel,
        chiefComplaint: data.chiefComplaint,
        suggestedQuestions: data.suggestedQuestions,
        provider: meta.provider,
        model: meta.model,
        promptVersion: meta.promptVersion,
        rawResponse: meta.rawResponse,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
        attempts,
        generatedAt: new Date(),
      },
    });

    log.info('pre-visit summary ready', {
      appointmentId,
      urgency: data.urgencyLevel,
      latencyMs: meta.latencyMs,
    });
    return { status: 'READY', urgencyLevel: data.urgencyLevel };
  } catch (err) {
    // Park as FAILED only once retries are exhausted; otherwise leave it PENDING
    // so the worker picks it up again.
    const exhausted = attempts >= MAX_SUMMARY_ATTEMPTS;
    const message = String(err.message ?? err).slice(0, 500);

    await prisma.preVisitSummary.upsert({
      where: { appointmentId },
      update: { status: exhausted ? 'FAILED' : 'PENDING', attempts, lastError: message },
      create: {
        appointmentId,
        status: exhausted ? 'FAILED' : 'PENDING',
        attempts,
        lastError: message,
      },
    });

    log.warn('pre-visit summary generation failed', {
      appointmentId,
      attempts,
      exhausted,
      error: message.slice(0, 160),
    });
    return { status: exhausted ? 'FAILED' : 'PENDING', error: message, attempts };
  }
}

/** Generates the patient-facing post-visit summary from the doctor's notes. */
export async function generatePostVisitSummary(appointmentId, { force = false } = {}) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      visitNote: { include: { prescriptions: true } },
      postVisitSummary: true,
    },
  });

  if (!appointment) throw new NotFoundError('Appointment');
  if (!appointment.visitNote) {
    return { status: 'SKIPPED', reason: 'The doctor has not submitted visit notes yet' };
  }
  if (appointment.postVisitSummary?.status === 'READY' && !force) {
    return { status: 'READY', cached: true };
  }

  const attempts = (appointment.postVisitSummary?.attempts ?? 0) + 1;
  const prompt = buildPostVisitPrompt({
    visitNote: appointment.visitNote,
    prescriptions: appointment.visitNote.prescriptions,
  });

  try {
    const { data, meta } = await generateStructured(prompt);

    await prisma.postVisitSummary.upsert({
      where: { appointmentId },
      update: {
        status: 'READY',
        patientFriendlyText: data.patientFriendlyText,
        medicationSchedule: data.medicationSchedule,
        followUpSteps: data.followUpSteps,
        warningSigns: data.warningSigns,
        provider: meta.provider,
        model: meta.model,
        promptVersion: meta.promptVersion,
        rawResponse: meta.rawResponse,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
        attempts,
        lastError: null,
        generatedAt: new Date(),
      },
      create: {
        appointmentId,
        status: 'READY',
        patientFriendlyText: data.patientFriendlyText,
        medicationSchedule: data.medicationSchedule,
        followUpSteps: data.followUpSteps,
        warningSigns: data.warningSigns,
        provider: meta.provider,
        model: meta.model,
        promptVersion: meta.promptVersion,
        rawResponse: meta.rawResponse,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
        attempts,
        generatedAt: new Date(),
      },
    });

    log.info('post-visit summary ready', { appointmentId, latencyMs: meta.latencyMs });
    return { status: 'READY' };
  } catch (err) {
    const exhausted = attempts >= MAX_SUMMARY_ATTEMPTS;
    const message = String(err.message ?? err).slice(0, 500);

    await prisma.postVisitSummary.upsert({
      where: { appointmentId },
      update: { status: exhausted ? 'FAILED' : 'PENDING', attempts, lastError: message },
      create: {
        appointmentId,
        status: exhausted ? 'FAILED' : 'PENDING',
        attempts,
        lastError: message,
      },
    });

    log.warn('post-visit summary generation failed', { appointmentId, attempts, exhausted });
    return { status: exhausted ? 'FAILED' : 'PENDING', error: message, attempts };
  }
}
