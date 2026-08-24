# LLM Integration

Provider-agnostic adapter. Swap providers with one environment variable — no code
change.

| Provider | `LLM_PROVIDER` | Notes |
|---|---|---|
| Google Gemini | `gemini` | Default. `gemini-3.6-flash` |
| Groq | `groq` | OpenAI-compatible, generous free tier |
| OpenRouter | `openrouter` | Has free models |
| Mock | `mock` | Deterministic stub; the automatic fallback when no key is set |

`mock` is not only a test double — it is the configured fallback, so the whole
application stays demonstrable without an API key. Its output is explicitly
labelled `[placeholder summary]` so it can never be mistaken for real triage.

## Prompts

Both prompts keep the task wording from the brief and add three things it lacks:
a strict output contract so parsing is deterministic; explicit scope limits,
because a model asked to "analyse symptoms" will otherwise volunteer a diagnosis;
and an instruction to work only from supplied text.

Prompts are **versioned**, and the version is stored on every generated summary.
Without that, a prompt change silently makes old and new rows incomparable and you
cannot tell whether a bad summary came from a bad model or a bad prompt.

Source: [`server/src/lib/llm/prompts.js`](../server/src/lib/llm/prompts.js).

### Pre-visit — `previsit-v1` (audience: the doctor)

System:

```
You are a clinical intake assistant supporting a licensed doctor who is about to
see a patient. Your output is read by the DOCTOR, never shown to the patient.

Rules:
- Do NOT diagnose. Do NOT suggest treatment, medication, or dosages.
- Summarise only what the patient reported. Do not invent symptoms or history.
- "urgencyLevel" reflects how soon a clinician should review this:
    HIGH   - red-flag features warranting same-day or emergency review
    MEDIUM - should be seen soon; persistent, worsening, or limiting
    LOW    - routine; stable, mild, or long-standing
- "chiefComplaint" is one clinical sentence in the doctor's register.
- "suggestedQuestions" are exactly three questions to narrow things down.
- If the text is too vague, set urgencyLevel "MEDIUM" and say so.

Respond with JSON only:
{"urgencyLevel":"LOW|MEDIUM|HIGH","chiefComplaint":"string",
 "suggestedQuestions":["string","string","string"]}
```

User: `Analyse these symptoms and return: urgency level (Low / Medium / High),
chief complaint, and three suggested questions for the doctor.` followed by the
symptom text, duration, severity, existing conditions and current medications.

Real output for *"crushing chest pain radiating to my left arm… sweating and
shortness of breath"*:

> **HIGH** — "Acute onset of severe (9/10) crushing chest pain radiating to the
> left arm since this morning, associated with diaphoresis and dyspnea, on a
> background of hypertension."

### Post-visit — `postvisit-v1` (audience: the patient)

System:

```
You rewrite a doctor's clinical notes into something the PATIENT can understand.

Rules:
- Plain language, roughly a 12-year-old reading level. Expand abbreviations.
- Convey ONLY what is in the notes and prescription. Never add a diagnosis,
  drug, dose, or instruction that is not already there.
- Never contradict or "correct" the doctor.
- Reassuring but honest. No alarming language, no false comfort.
- "medicationSchedule" derives strictly from the prescription supplied. Convert
  clinical frequency into everyday wording: TWICE_DAILY -> ["morning","night"].
- "warningSigns" only if the notes support it; otherwise an empty array.

Respond with JSON only:
{"patientFriendlyText":"string","medicationSchedule":[{...}],
 "followUpSteps":["string"],"warningSigns":["string"]}
```

User: `Convert these clinical notes into a patient-friendly summary with
medication schedule and follow-up steps.` followed by the notes, diagnosis,
advice, follow-up date and prescription.

Real output — `"dysuria… +ve nitrites and leukocytes"` became:

> "You came in with painful urination and needing to pee more often over the past
> 3 days. A urine test showed signs of a lower urinary tract infection (UTI)."

with `Nitrofurantoin 100 mg → ["morning","night"]` and warning signs *Fever,
Flank pain* correctly lifted from the doctor's advice.

## Why generation is asynchronous

Measured latency on the free tier: **4–14 seconds** typically, and **129 seconds**
once on an overloaded model alias. No user-facing request waits on that.
Confirming a booking writes a `PENDING` summary row and returns immediately; a
background worker fills it in.

## Failure handling

| Failure | Response |
|---|---|
| Provider hangs | `AbortController` timeout at `LLM_TIMEOUT_MS` |
| 429 / 5xx / network | Retried with exponential backoff + jitter |
| 400 / 401 / 404 / safety block | Fails immediately — retrying burns quota |
| Non-JSON or wrong shape | Retried (usually a sampling artefact), then parked |
| Retries exhausted | Row `FAILED` with `lastError`; nothing else affected |

Output is validated with Zod, not trusted. JSON mode guarantees syntax, not shape.
Responses wrapped in markdown fences or prefixed with prose are recovered before
parsing.

**Nothing in the booking path depends on the LLM succeeding.** Verified under a
deliberately invalid API key: booking, confirmation, visit notes, medication
reminders and completion all still work, and the doctor still sees the raw symptom
text.

```bash
cd server && npm run verify:degradation
```
