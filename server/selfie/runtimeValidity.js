import path from 'node:path';
import { createLocalPaths, inspectSdRuntimeStructure } from './localPaths.js';
import { runCommand } from './sdcppMemory.js';

/** Validate only the selected build; never combine files from different variants. */
export async function inspectSdRuntime(paths = createLocalPaths(), {
  probeCommand = runCommand, env = process.env, signal, timeoutMs = 5000,
} = {}) {
  signal?.throwIfAborted();
  const result = inspectSdRuntimeStructure(paths);
  if (!result.structurallyValid) return result;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`sd-cli --help exceeded ${timeoutMs}ms.`)), timeoutMs);
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    const probe = await Promise.race([probeCommand(result.binaryPath, ['--help'], {
      cwd: path.dirname(result.binaryPath), env, signal: controller.signal, timeoutMs,
    }), aborted]);
    signal?.throwIfAborted();
    const exitCode = probe.code ?? probe.exitCode ?? 0;
    const helpOutput = probe.output ?? `${probe.stdout || ''}\n${probe.stderr || ''}`;
    return { ...result, valid: exitCode === 0,
      code: exitCode === 0 ? 'READY' : 'LOCAL_SDCLI_HELP_FAILED',
      helpOutput: exitCode === 0 ? helpOutput : null,
      message: exitCode === 0 ? 'Local sd-cli --help passed.' : `Local sd-cli --help exited ${exitCode}: ${result.binaryPath}.`,
      publicMessage: exitCode === 0 ? 'Local sd-cli --help passed.' : `Local sd-cli --help exited ${exitCode}.`,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...result, valid: false, code: /exceeded|timed out/i.test(error.message) ? 'LOCAL_SDCLI_HELP_TIMEOUT' : 'LOCAL_SDCLI_HELP_FAILED',
      message: `Local sd-cli --help failed for ${result.binaryPath}: ${error.message}`,
      publicMessage: /exceeded|timed out/i.test(error.message) ? 'Local sd-cli --help timed out.' : 'Local sd-cli --help failed; see backend logs.',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
