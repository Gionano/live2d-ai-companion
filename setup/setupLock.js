import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function lockError(message) {
  return Object.assign(new Error(message), { code: 'LOCK_BUSY' });
}

/** One lease covers UI setup, CLI setup, and the wait for active PAP work. */
async function acquireLease(localDir, name, { signal } = {}) {
  signal?.throwIfAborted();
  await fs.mkdir(localDir, { recursive: true });
  const filename = path.join(localDir, name);
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (current.id === id) await fs.unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch { throw lockError('Setup lock cannot be verified; another installation may be active.'); }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0 || typeof previous.id !== 'string') {
        throw lockError('Setup lock has invalid owner metadata.');
      }
      try { process.kill(previous.pid, 0); throw lockError('Another UI or CLI installation is active.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      // Do not remove a lease that changed while its owner was being checked.
      const current = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (current.id !== previous.id) throw lockError('Another installation acquired the setup lock.');
      await fs.unlink(filename);
    }
  }
  throw lockError('Another installation acquired the setup lock.');
}

export const acquireSetupLock = (localDir, options) => acquireLease(localDir, 'setup.lock', options);
export const acquireSetupReservation = (localDir, options) => acquireLease(localDir, 'setup-request.lock', options);

async function liveLease(filename) {
  let record;
  try { record = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw lockError('Runtime ownership cannot be verified.');
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0) throw lockError('Runtime ownership has invalid metadata.');
  try { process.kill(record.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Backend holds this lease while local image work owns shared runtime/model files. */
export async function acquireRuntimeLease(localDir, options = {}) {
  if (await liveLease(path.join(localDir, 'setup.lock'))) throw lockError('An installation owns the local runtime.');
  const release = await acquireLease(localDir, 'runtime.lock', options);
  if (await liveLease(path.join(localDir, 'setup.lock'))) {
    await release();
    throw lockError('An installation acquired the local runtime.');
  }
  return release;
}

/** Standalone CLI must refuse active backend work and warm owned ComfyUI children. */
export async function assertRuntimeIdle(localDir, { repoRoot } = {}) {
  if (await liveLease(path.join(localDir, 'runtime.lock'))) throw lockError('Local PAP work is active; wait until playback/generation cleanup finishes.');
  if (repoRoot) {
    const stateFile = path.join(repoRoot, 'data', 'comfyui-managed-process.json');
    let record;
    try { record = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw lockError('Managed ComfyUI ownership cannot be verified.'); }
    if (Number.isInteger(record.pid) && record.pid > 0) {
      try { process.kill(record.pid, 0); throw lockError('A managed ComfyUI process is still running. Stop it through its owning application before CLI setup.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
