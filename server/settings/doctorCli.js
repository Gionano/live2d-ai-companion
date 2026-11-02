import { createLocalPaths } from '../selfie/localPaths.js';
import { settingsDoctor } from './doctor.js';
try {
  const { localDir } = createLocalPaths();
  const result = settingsDoctor({ localDir, includePaths: true, allowPlaintext: process.env.WAIFU_ALLOW_PLAINTEXT_SECRETS === '1' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.selfTest.ok && result.selfTest.code !== 'READ_ONLY') process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ error: { code: 'STORAGE' } }) + '\n');
  process.exitCode = 1;
}
