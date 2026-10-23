import fs from 'node:fs';
import path from 'node:path';
import { createPackagedSelfieConfig } from '../src/main/selfieOutputDir.js';

export default function packageSelfieConfig({ appOutDir, packager }) {
  const configPath = path.resolve(packager.projectDir, '..', 'selfie.config.json');
  const resourcesDir = path.join(appOutDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'selfie.config.json'),
    `${JSON.stringify(createPackagedSelfieConfig(configPath), null, 2)}\n`, 'utf8');
}
