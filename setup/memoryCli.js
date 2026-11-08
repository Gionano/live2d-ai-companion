import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installMemorySetup, planMemorySetup, inspectMemoryInstallation, verifyMemoryInstallation } from './memorySetup.js';

export function parseMemoryArgs(argv) {
  const command = argv[0] || 'plan';
  if (!['plan', 'install', 'doctor'].includes(command)) throw new Error('Use plan, install or doctor.');
  const options = { acceptedLicenses: [] };
  for (let index = 1; index < argv.length; index++) {
    const [flag, inline] = argv[index].split(/=(.*)/s);
    if (flag === '--verify-hashes') { options.verifyHashes = true; continue; }
    if (!['--python', '--device', '--accept-license'].includes(flag)) throw new Error('Unknown memory setup argument.');
    const value = inline === undefined ? argv[++index] : inline;
    if (!value || value.startsWith('--')) throw new Error('Missing memory setup argument value.');
    if (flag === '--accept-license') options.acceptedLicenses.push(value);
    else options[flag.slice(2)] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2), { output = console.log, ...dependencies } = {}) {
  try {
    const { command, options } = parseMemoryArgs(argv);
    if (command === 'doctor') {
      const status = options.verifyHashes ? await verifyMemoryInstallation(dependencies.paths)
        : inspectMemoryInstallation(dependencies.paths);
      output(JSON.stringify({ ready: status.valid, code: status.code, missing: status.missing, interrupted: status.interrupted }));
      return status.valid ? 0 : 1;
    }
    if (command === 'install') {
      const result = await installMemorySetup({ ...options, ...dependencies, log: output });
      output(JSON.stringify(result));
      return 0;
    }
    const plan = await planMemorySetup({ ...options, ...dependencies });
    output(JSON.stringify({ ready: plan.ready, model: plan.model, device: plan.device, wheel: plan.wheel,
      modelBytes: plan.modelBytes, requiredBytes: plan.requiredBytes, freeBytes: plan.freeBytes,
      components: plan.components, licenses: plan.licenses, blockers: plan.blockers, interrupted: plan.interrupted }, null, 2));
    output('Install explicitly with npm run setup:memory -- --accept-license=bge-m3 --accept-license=pytorch --accept-license=transformers --accept-license=huggingface-hub');
    return plan.blockers.length ? 1 : 0;
  } catch (error) {
    output(`Memory setup failed: ${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SETUP_FAILED'}. Cached downloads are retained for an explicit retry.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
