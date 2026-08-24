import { env } from '../../../config/env.js';
import { ExternalServiceError } from '../../errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Google Gemini via the Generative Language API.
 *
 * `responseMimeType: application/json` puts the model in JSON mode, which is a
 * far stronger guarantee than asking for JSON in the prompt - but the adapter
 * still validates, because JSON mode guarantees syntax, not shape.
 */
export const geminiProvider = {
  name: 'gemini',
  model: () => env.GEMINI_MODEL,

  async complete({ system, user, signal, temperature = 0.2, maxTokens = 2048 }) {
    const res = await fetch(`${ENDPOINT}/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      // 429 and 5xx are transient; 400/401/403/404 are not worth retrying.
      const retryable = res.status === 429 || res.status >= 500;
      throw new ExternalServiceError(
        'gemini',
        `Gemini returned ${res.status}: ${body.slice(0, 300)}`,
        { retryable }
      );
    }

    const json = await res.json();
    const candidate = json?.candidates?.[0];

    // A blocked or truncated response has no usable text - treat it as a
    // failure rather than letting an empty string reach the parser.
    const finish = candidate?.finishReason;
    if (finish && !['STOP', 'MAX_TOKENS'].includes(finish)) {
      throw new ExternalServiceError('gemini', `Generation stopped: ${finish}`, {
        retryable: false,
      });
    }

    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
      throw new ExternalServiceError('gemini', 'Gemini returned an empty response');
    }

    return {
      text,
      model: env.GEMINI_MODEL,
      tokensUsed: json?.usageMetadata?.totalTokenCount ?? null,
    };
  },
};
