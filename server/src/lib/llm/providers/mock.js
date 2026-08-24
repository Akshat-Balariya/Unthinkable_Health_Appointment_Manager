import { PRE_VISIT_VERSION } from '../prompts.js';

/**
 * Deterministic stand-in for a real provider.
 *
 * This is not only a test fixture - it is the configured fallback when no API
 * key is present, so the whole application remains demonstrable without one.
 * Output is derived from crude keyword matching and is explicitly labelled as
 * machine-generated placeholder text, so it can never be mistaken for real
 * clinical triage.
 */

const RED_FLAGS = [
  'chest pain',
  'shortness of breath',
  'breathless',
  'bleeding',
  'unconscious',
  'fainting',
  'seizure',
  'stroke',
  'numbness',
  'slurred',
  'suicidal',
  'severe',
];

const MEDIUM_FLAGS = ['fever', 'persistent', 'worsening', 'vomiting', 'infection', 'pain'];

function classify(text) {
  const lower = String(text).toLowerCase();
  if (RED_FLAGS.some((f) => lower.includes(f))) return 'HIGH';
  if (MEDIUM_FLAGS.some((f) => lower.includes(f))) return 'MEDIUM';
  return 'LOW';
}

export const mockProvider = {
  name: 'mock',
  model: () => 'mock-deterministic-v1',

  async complete({ system, user }) {
    const isPreVisit = system.includes('clinical intake assistant');

    if (isPreVisit) {
      const symptoms = (/Symptoms: (.*)/.exec(user)?.[1] ?? user).slice(0, 200);
      return {
        text: JSON.stringify({
          urgencyLevel: classify(user),
          chiefComplaint: `[placeholder summary] Patient reports: ${symptoms}`,
          suggestedQuestions: [
            'When did these symptoms first begin, and have they changed since?',
            'Is anything making the symptoms better or worse?',
            'Any relevant medical history, allergies or current medication?',
          ],
        }),
        model: 'mock-deterministic-v1',
        tokensUsed: 0,
      };
    }

    const diagnosis = /Diagnosis: (.*)/.exec(user)?.[1] ?? 'your recent consultation';
    return {
      text: JSON.stringify({
        patientFriendlyText:
          `[placeholder summary] Your doctor reviewed your symptoms and noted ${diagnosis}. ` +
          'Please follow the instructions below and contact the clinic if anything worsens.',
        medicationSchedule: [],
        followUpSteps: ['Follow the advice your doctor gave during the visit.'],
        warningSigns: [],
      }),
      model: 'mock-deterministic-v1',
      tokensUsed: 0,
    };
  },
};

export { PRE_VISIT_VERSION };
