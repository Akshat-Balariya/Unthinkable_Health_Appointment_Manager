import { env, activeLlmProvider } from '../../config/env.js';
import { logger } from '../logger.js';
import { ExternalServiceError } from '../errors.js';
import { geminiProvider } from './providers/gemini.js';
import { groqProvider, openrouterProvider } from './providers/openaiCompatible.js';
import { mockProvider } from './providers/mock.js';

const log = logger.child('llm');

const REGISTRY = {
  gemini: geminiProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
  mock: mockProvider,
};

/** Resolved per call, so a key added at runtime takes effect without a restart. */
export function currentProvider() {
  return REGISTRY[activeLlmProvider()] ?? mockProvider;
}

/**
 * Pulls a JSON object out of a model response.
 *
 * Even in JSON mode a model can wrap output in markdown fences or prepend a
 * sentence, so the raw text is never handed straight to JSON.parse.
 */
export function extractJson(text) {
  const trimmed = String(text).trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // ```json ... ``` fences
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // First balanced {...} in the text.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, so parallel retries do not synchronise. */
function backoffMs(attempt) {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 400);
}

/**
 * Runs a prompt and returns validated, typed output.
 *
 * Failure handling, in order:
 *   1. every call is wrapped in an AbortController timeout, so a provider that
 *      hangs (observed: 129s on an overloaded alias) cannot stall a worker
 *   2. transient failures - 429, 5xx, network, timeout - are retried with
 *      exponential backoff
 *   3. non-transient failures - 400, 401, 404, safety blocks - fail immediately,
 *      because retrying a malformed request just burns quota
 *   4. unparseable or schema-invalid output is retried too: it is usually a
 *      sampling artefact and a second attempt normally succeeds
 *
 * Throws only after exhausting attempts. Callers are expected to catch and
 * degrade rather than propagate - no user-facing operation depends on this
 * succeeding.
 */
export async function generateStructured({
  system,
  user,
  schema,
  version,
  temperature = 0.2,
  maxTokens = 2048,
  maxAttempts = env.LLM_MAX_ATTEMPTS,
}) {
  const provider = currentProvider();
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

    try {
      const result = await provider.complete({
        system,
        user,
        signal: controller.signal,
        temperature,
        maxTokens,
      });

      const parsed = extractJson(result.text);
      if (parsed === undefined) {
        throw new ExternalServiceError(
          provider.name,
          `Response was not valid JSON: ${String(result.text).slice(0, 200)}`
        );
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new ExternalServiceError(
          provider.name,
          `Response did not match the expected shape (${issues})`
        );
      }

      const latencyMs = Date.now() - startedAt;
      log.info('generation succeeded', {
        provider: provider.name,
        model: result.model,
        version,
        attempt,
        latencyMs,
      });

      return {
        data: validated.data,
        meta: {
          provider: provider.name,
          model: result.model,
          promptVersion: version,
          tokensUsed: result.tokensUsed,
          latencyMs,
          attempts: attempt,
          rawResponse: parsed,
        },
      };
    } catch (err) {
      clearTimeout(timer);

      const isAbort = err.name === 'AbortError';
      lastError = isAbort
        ? new ExternalServiceError(provider.name, `Timed out after ${env.LLM_TIMEOUT_MS}ms`)
        : err;

      // Explicitly non-retryable provider errors stop the loop immediately.
      const retryable = lastError.retryable !== false;
      const hasAttemptsLeft = attempt < maxAttempts;

      log.warn('generation attempt failed', {
        provider: provider.name,
        version,
        attempt,
        retryable,
        error: lastError.message?.slice(0, 200),
      });

      if (!retryable || !hasAttemptsLeft) break;
      await sleep(backoffMs(attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new ExternalServiceError(provider.name, 'Generation failed');
}

/** Lightweight reachability probe, surfaced on /health/ready. */
export async function probeProvider() {
  const provider = currentProvider();
  if (provider.name === 'mock') return { provider: 'mock', reachable: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await provider.complete({
      system: 'Reply with JSON.',
      user: 'Return {"ok":true}',
      signal: controller.signal,
      maxTokens: 32,
    });
    return { provider: provider.name, reachable: true };
  } catch (e) {
    return { provider: provider.name, reachable: false, error: e.message?.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
