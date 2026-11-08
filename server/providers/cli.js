import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testSlot } from './testSlot.js';
import { SLOT_CAPABILITIES } from './config.js';

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!['--slot', '--profile', '--model'].includes(flag)) throw new Error('Use --slot, --profile and --model only.');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error('Each option needs a value.');
    options[flag.slice(2)] = value;
  }
  if (options.slot && !Object.hasOwn(SLOT_CAPABILITIES, options.slot)) throw new Error('Unknown slot. Use llm, surface, reflection, router, planner, vision, visionFilter, stt or tts.');
  return options;
}

export async function runCli(args, { probe = testSlot, print = console.table } = {}) {
  const { slot, ...options } = parseArgs(args);
  const results = [];
  for (const name of slot ? [slot] : Object.keys(SLOT_CAPABILITIES)) results.push(await probe(name, options));
  print(results.map(result => ({ slot: result.details.slot, profile: result.details.profile, model: result.details.model,
    ok: result.ok, latencyMs: result.latencyMs, ttftMs: result.ttftMs ?? '-',
    tokens: result.tokens ? JSON.stringify(result.tokens) : '-', error: result.error ? `${result.error.code}: ${result.error.message}` : '' })));
  return results.every(result => result.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Provider test could not run. Check the options and provider configuration.');
    process.exitCode = 1;
  });
}
