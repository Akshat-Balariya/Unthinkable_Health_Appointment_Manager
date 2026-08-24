import { env } from '../../../config/env.js';
import { ExternalServiceError } from '../../errors.js';

/**
 * Groq and OpenRouter both speak the OpenAI chat-completions dialect, so one
 * implementation serves both. Only the base URL, key and model differ.
 */
function makeProvider({ name, baseUrl, apiKey, model, extraHeaders = {} }) {
  return {
    name,
    model,
    async complete({ system, user, signal, temperature = 0.2, maxTokens = 2048 }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey()}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model: model(),
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        throw new ExternalServiceError(
          name,
          `${name} returned ${res.status}: ${body.slice(0, 300)}`,
          { retryable }
        );
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        throw new ExternalServiceError(name, `${name} returned an empty response`);
      }

      return {
        text,
        model: json?.model ?? model(),
        tokensUsed: json?.usage?.total_tokens ?? null,
      };
    },
  };
}

export const groqProvider = makeProvider({
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: () => env.GROQ_API_KEY,
  model: () => env.GROQ_MODEL,
});

export const openrouterProvider = makeProvider({
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: () => env.OPENROUTER_API_KEY,
  model: () => env.OPENROUTER_MODEL,
  extraHeaders: { 'X-Title': 'Healthcare Appointment Manager' },
});
