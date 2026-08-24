/** Runs the degradation test with a deliberately invalid API key, cross-platform. */
import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['scripts/verify-llm-degradation.js'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      GEMINI_API_KEY: 'deliberately-broken-key',
      GROQ_API_KEY: 'deliberately-broken-key',
      OPENROUTER_API_KEY: 'deliberately-broken-key',
    },
  }
);
child.on('exit', (code) => process.exit(code ?? 1));
