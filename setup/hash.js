import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function hashFile(filePath, { signal } = {}) {
  signal?.throwIfAborted();
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('setup:hash requires an existing file path');
  const resolved = path.resolve(filePath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error(`setup:hash requires a regular file: ${resolved}`);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(resolved, signal ? { signal } : undefined)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  const after = await fs.promises.stat(resolved);
  if (stat.size !== sizeBytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new Error(`File changed while hashing: ${resolved}; rerun setup:hash`);
  }
  const sha256 = hash.digest('hex');
  return { filePath: resolved, sizeBytes, sha256, snippet: { name: path.basename(resolved), sizeBytes, sha256 } };
}

export function formatHash(result) {
  return `File: ${result.filePath}\nSize: ${result.sizeBytes} bytes\nSHA-256: ${result.sha256}\n`
    + `Manifest snippet (merge into the verified component):\n${JSON.stringify(result.snippet, null, 2)}`;
}
