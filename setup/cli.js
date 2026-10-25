import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup } from './install.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { hashFile, formatHash } from './hash.js';

export function parseArgs(argv) {
  const command = argv[0] || 'plan';
  const options = { yes: false, force: false, acceptLicenses: [] };
  for (let index = 1; index < argv.length; index += 1) {
    if (command === 'hash' && !argv[index].startsWith('-')) {
      if (options.filePath) throw new Error('setup:hash accepts one local file');
      options.filePath = path.resolve(argv[index]);
      continue;
    }
    const [flag, inline] = argv[index].split(/=(.*)/s);
    if (['--yes', '--force', '--skip-pip', '--verify-hashes'].includes(flag)) {
      if (inline !== undefined) throw new Error(`${flag} does not accept a value; omit the flag for a dry run`);
      if (flag === '--yes') options.yes = true;
      else if (flag === '--force') options.force = true;
      else if (flag === '--skip-pip') options.skipPip = true;
      else options.verifyHashes = true;
    }
    else if (['--manifest', '--accept-license', '--engine', '--variant'].includes(flag)) {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--manifest') options.manifestPath = path.resolve(value);
      else if (flag === '--accept-license') options.acceptLicenses.push(value);
      else if (flag === '--engine') options.engine = value;
      else options.variant = value;
    } else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown setup option: ${flag}`);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);
    if (options.help) {
      console.log('Usage: node setup/cli.js plan|models|sdcli|comfyui|doctor [--manifest PATH] [--engine comfyui|sdcpp] [--variant cuda12|vulkan] [--yes] [--force] [--skip-pip] [--accept-license NAME ...]\n       node setup/cli.js doctor [--verify-hashes]\n       node setup/cli.js hash FILE');
      return 0;
    }
    if (command === 'hash') {
      if (!options.filePath) throw new Error('Usage: npm run setup:hash -- FILE (offline local file only)');
      console.log(formatHash(await hashFile(options.filePath)));
      return 0;
    }
    if (command === 'doctor') {
      const report = await runDoctor({ manifestPath: options.manifestPath, engine: options.engine, variant: options.variant, verifyHashes: options.verifyHashes });
      console.log(formatDoctor(report));
      return report.ok ? 0 : 1;
    }
    await runSetup(command, options);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
