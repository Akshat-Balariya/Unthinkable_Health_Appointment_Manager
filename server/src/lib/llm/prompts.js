import { z } from 'zod';

/**
 * Prompt definitions.
 *
 * Each prompt is VERSIONED and the version is stored alongside every generated
 * summary. Without that, a prompt change silently makes old and new rows
 * incomparable, and you cannot tell whether a bad summary came from a bad model
 * or a bad prompt.
 *
 * Both prompts keep the task wording given in the brief and add three things
 * the raw wording lacks:
 *   - a strict output contract, so parsing is deterministic rather than regex
 *     archaeology over prose
 *   - explicit scope limits, because an LLM asked to "analyse symptoms" will
 *     otherwise volunteer a diagnosis
 *   - an instruction to work only from supplied text, to limit invention
 */

// ---------------------------------------------------------------------------
// Pre-visit: symptoms -> triage summary FOR THE DOCTOR
// ---------------------------------------------------------------------------

export const PRE_VISIT_VERSION = 'previsit-v1';

export const preVisitOutputSchema = z.object({
  urgencyLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  chiefComplaint: z.string().trim().min(1).max(300),
  suggestedQuestions: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
});

const PRE_VISIT_SYSTEM = `You are a clinical intake assistant supporting a licensed doctor who is about to see a patient.

Your output is read by the DOCTOR, never shown to the patient.

Rules:
- Do NOT diagnose. Do NOT suggest treatment, medication, or dosages.
- Summarise only what the patient reported. Do not invent symptoms, history, or vitals.
- "urgencyLevel" reflects how soon a clinician should review this, not severity of any presumed disease:
    HIGH   - red-flag features that warrant same-day or emergency review
    MEDIUM - should be seen soon; symptoms are persistent, worsening, or functionally limiting
    LOW    - routine; stable, mild, or long-standing complaints
- "chiefComplaint" is one clinical sentence in the doctor's register.
- "suggestedQuestions" are exactly three questions the doctor should ask to narrow things down.
- If the symptom text is too vague to assess, set urgencyLevel to "MEDIUM" and say so in chiefComplaint.

Respond with JSON only, matching this shape exactly:
{"urgencyLevel":"LOW|MEDIUM|HIGH","chiefComplaint":"string","suggestedQuestions":["string","string","string"]}`;

export function buildPreVisitPrompt(report) {
  const details = [
    `Symptoms: ${report.symptomsText}`,
    report.durationDays != null ? `Duration: ${report.durationDays} day(s)` : null,
    report.severity != null ? `Self-reported severity: ${report.severity}/10` : null,
    report.existingConditions ? `Existing conditions: ${report.existingConditions}` : null,
    report.currentMedications ? `Current medications: ${report.currentMedications}` : null,
    report.additionalNotes ? `Additional notes: ${report.additionalNotes}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    version: PRE_VISIT_VERSION,
    system: PRE_VISIT_SYSTEM,
    user:
      'Analyse these symptoms and return: urgency level (Low / Medium / High), ' +
      'chief complaint, and three suggested questions for the doctor.\n\n' +
      details,
    schema: preVisitOutputSchema,
  };
}

// ---------------------------------------------------------------------------
// Post-visit: clinical notes -> plain-language summary FOR THE PATIENT
// ---------------------------------------------------------------------------

export const POST_VISIT_VERSION = 'postvisit-v1';

export const medicationScheduleItemSchema = z.object({
  medication: z.string().trim().min(1).max(200),
  dosage: z.string().trim().max(100).optional().default(''),
  whenToTake: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  durationDays: z.number().int().min(0).max(3650).nullable().optional(),
  notes: z.string().trim().max(300).optional().default(''),
});

export const postVisitOutputSchema = z.object({
  patientFriendlyText: z.string().trim().min(1).max(4000),
  medicationSchedule: z.array(medicationScheduleItemSchema).max(20).default([]),
  followUpSteps: z.array(z.string().trim().min(1).max(400)).max(10).default([]),
  warningSigns: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});

const POST_VISIT_SYSTEM = `You rewrite a doctor's clinical notes into something the PATIENT can understand.

Rules:
- Use plain language at roughly a 12-year-old reading level. Expand abbreviations.
- Convey ONLY what is in the notes and prescription. Never add a diagnosis, drug,
  dose, or instruction that is not already there.
- Never contradict or "correct" the doctor.
- Reassuring but honest in tone. No alarming language, no false comfort.
- "medicationSchedule" must be derived strictly from the prescription supplied.
  Convert clinical frequency into everyday wording, e.g. TWICE_DAILY becomes
  ["morning","night"]. If no medication was prescribed, return an empty array.
- "warningSigns" are symptoms that should prompt the patient to seek help sooner.
  Only include them if the notes support it; otherwise return an empty array.
- Do not address the patient by name.

Respond with JSON only, matching this shape exactly:
{"patientFriendlyText":"string","medicationSchedule":[{"medication":"string","dosage":"string","whenToTake":["string"],"durationDays":number|null,"notes":"string"}],"followUpSteps":["string"],"warningSigns":["string"]}`;

const FREQUENCY_WORDS = {
  ONCE_DAILY: 'once a day',
  TWICE_DAILY: 'twice a day',
  THRICE_DAILY: 'three times a day',
  FOUR_TIMES_DAILY: 'four times a day',
  EVERY_OTHER_DAY: 'every other day',
  WEEKLY: 'once a week',
  AS_NEEDED: 'only when needed',
};

export function buildPostVisitPrompt({ visitNote, prescriptions = [] }) {
  const meds = prescriptions.length
    ? prescriptions
        .map(
          (p) =>
            `- ${p.medicationName} ${p.dosage}, ${FREQUENCY_WORDS[p.frequency] ?? p.frequency}` +
            `, for ${p.durationDays} day(s)` +
            (p.instructions ? ` (${p.instructions})` : '')
        )
        .join('\n')
    : '(no medication prescribed)';

  const details = [
    `Clinical notes: ${visitNote.clinicalNotes}`,
    visitNote.diagnosis ? `Diagnosis: ${visitNote.diagnosis}` : null,
    visitNote.advice ? `Advice given: ${visitNote.advice}` : null,
    visitNote.followUpDate
      ? `Follow-up date: ${new Date(visitNote.followUpDate).toISOString().slice(0, 10)}`
      : null,
    `Prescription:\n${meds}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    version: POST_VISIT_VERSION,
    system: POST_VISIT_SYSTEM,
    user:
      'Convert these clinical notes into a patient-friendly summary with ' +
      'medication schedule and follow-up steps.\n\n' +
      details,
    schema: postVisitOutputSchema,
  };
}
