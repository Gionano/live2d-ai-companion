import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

const RUNS_PATH = path.join(ROOT_DIR, 'docs', 'selfie-runs.md');
const APPENDS = new Map();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TABLE_COLUMNS = '| Label | Provider | Profile | Size | Steps | CFG | Strength | Extra / dropped args | Seed | Durations (ms) | Peak VRAM (GB) | Peak working set (GB) | Peak private bytes (GB) | Peak commit (GB) | Peak shared GPU (GB) | Output path | Status | Init image | Reference |';
const TABLE_SCHEMA = TABLE_COLUMNS + '\n'
  + '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const TABLE_HEADER = '# Selfie runs\n\n' + TABLE_SCHEMA;
const TABLE_UPGRADE = '\n## Managed provider telemetry\n\n' + TABLE_SCHEMA;

function cell(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\').replace(/([`*_\[\]])/g, '\\$1').replace(/\|/g, '&#124;')
    .replace(/\r\n|\r|\n/g, '<br>').replace(/\t/g, ' ');
}

function metric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? String(Math.round(value * 1000) / 1000) : '-';
}

function formatRow(row) {
  const args = [];
  if (row.args?.length) args.push('extra: ' + JSON.stringify(row.args));
  if (row.droppedArgs?.length) args.push('dropped: ' + JSON.stringify(row.droppedArgs));
  if (row.modelArgs?.length) args.push('model: ' + JSON.stringify(row.modelArgs));
  const durations = Object.entries(row.timings || {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .map(([key, value]) => key + '=' + metric(value)).join('; ');
  const peaks = row.peaks || {};
  return '| ' + [
    row.label, row.provider, row.profile,
    row.width && row.height ? row.width + 'x' + row.height : null,
    row.steps, row.cfg, row.strength, args.join('; '), row.seed, durations,
    metric(peaks.vramUsedGB), metric(peaks.peakWorkingSetGB), metric(peaks.privateBytesGB), metric(peaks.commitUsedGB),
    metric(peaks.sharedGpuUsedGB ?? peaks.sharedGpuGB ?? peaks.sharedGpuMemoryGB),
    row.imagePath, row.status, row.initImage, row.reference,
  ].map(cell).join(' | ') + ' |\n';
}

async function appendRow(filePath, row) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let file;
  try {
    file = await fs.open(filePath, 'ax');
    await file.writeFile(TABLE_HEADER + formatRow(row), 'utf8');
  } catch (error) {
    if (error.code !== 'EEXIST' || file) throw error;
    file = await fs.open(filePath, 'a+');
    const { size } = await file.stat();
    let prefix = size === 0 ? TABLE_HEADER : '';
    if (size > 0) {
      const existing = await file.readFile('utf8');
      if (!existing.endsWith('\n')) prefix = '\n';
      const lastHeader = existing.split(/\r?\n/).filter(line => line.startsWith('| Label | Provider |')).at(-1);
      if (lastHeader !== TABLE_COLUMNS) prefix += TABLE_UPGRADE;
    }
    await file.writeFile(prefix + formatRow(row), 'utf8');
  } finally {
    await file?.close();
  }
}

/** Append one experiment without rewriting any existing bytes or rows. */
export async function appendSelfieRun(row, { filePath = RUNS_PATH } = {}) {
  const target = path.resolve(filePath);
  const previous = APPENDS.get(target) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => appendRow(target, row));
  APPENDS.set(target, pending);
  try {
    await pending;
  } finally {
    if (APPENDS.get(target) === pending) APPENDS.delete(target);
  }
}

async function readAt(file, length, position = 0) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function jpegDimensions(file, size) {
  let position = 2;
  while (position + 4 <= size) {
    let marker = await readAt(file, 2, position);
    if (marker.length !== 2 || marker[0] !== 0xff) break;
    while (marker[1] === 0xff) {
      position++;
      marker = await readAt(file, 2, position);
      if (marker.length !== 2) break;
    }
    const kind = marker[1];
    position += 2;
    if (kind === 0xd9 || kind === 0xda) break;
    if (kind === 0x01 || (kind >= 0xd0 && kind <= 0xd7)) continue;
    const segment = await readAt(file, 7, position);
    if (segment.length < 2) break;
    const length = segment.readUInt16BE(0);
    if (length < 2 || position + length > size) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(kind)) {
      if (segment.length < 7 || length < 8) break;
      return { width: segment.readUInt16BE(5), height: segment.readUInt16BE(3) };
    }
    position += length;
  }
  throw new Error('JPEG dimensions are missing or invalid.');
}

/** Read only container metadata; no pixel decoding or image analysis. */
export async function readImageMetadata(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Image path is not a file.');
    const header = await readAt(file, 32);
    let dimensions;
    if (header.length >= 24 && header.subarray(0, 8).equals(PNG_SIGNATURE)
      && header.readUInt32BE(8) === 13 && header.toString('ascii', 12, 16) === 'IHDR') {
      dimensions = { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    } else if (header.length >= 2 && header[0] === 0xff && header[1] === 0xd8) {
      dimensions = await jpegDimensions(file, stat.size);
    } else if (header.length >= 30 && header.toString('ascii', 0, 4) === 'RIFF'
      && header.toString('ascii', 8, 12) === 'WEBP') {
      const kind = header.toString('ascii', 12, 16);
      if (kind === 'VP8X') {
        dimensions = { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3) };
      } else if (kind === 'VP8 ' && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
        dimensions = { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff };
      } else if (kind === 'VP8L' && header[20] === 0x2f) {
        const bits = header.readUInt32LE(21);
        dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
    }
    if (!dimensions || !dimensions.width || !dimensions.height) {
      throw new Error('Unsupported image format or invalid dimensions (expected PNG, JPEG, or WebP).');
    }
    return { filePath, ...dimensions, bytes: stat.size };
  } finally {
    await file.close();
  }
}

export async function compareImages(paths, output = console) {
  if (!Array.isArray(paths) || paths.length !== 2) {
    output.error('FAILED [COMPARE]: --compare requires two image paths.');
    return 1;
  }
  let code = 0;
  for (const filePath of paths) {
    try {
      const metadata = await readImageMetadata(filePath);
      output.log(filePath + ': ' + metadata.width + 'x' + metadata.height + ', ' + metadata.bytes + ' bytes');
    } catch (error) {
      output.error('FAILED [COMPARE]: ' + filePath + ': ' + error.message);
      code = 1;
    }
  }
  return code;
}
