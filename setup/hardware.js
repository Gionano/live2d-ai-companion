import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GPU_QUERY = 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress';

export async function probeGpuCommand(command, args, { timeoutMs = 5000 } = {}) {
  const result = await execFileAsync(command, args, {
    timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  return { code: 0, ...result };
}

/** Read adapter names offline; an unavailable probe leaves a visible Vulkan default. */
export async function detectGpuVendor({ commandRunner = probeGpuCommand, platform = process.platform } = {}) {
  try {
    let devices;
    if (platform === 'win32') {
      const result = await commandRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_QUERY], { timeoutMs: 5000 });
      if (result.code && result.code !== 0) throw new Error(`GPU probe exited ${result.code}`);
      const values = JSON.parse(result.stdout || 'null');
      devices = (Array.isArray(values) ? values : [values]).filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim());
    } else if (platform === 'linux') {
      const result = await commandRunner('lspci', ['-nn'], { timeoutMs: 5000 });
      if (result.code && result.code !== 0) throw new Error(`GPU probe exited ${result.code}`);
      devices = (result.stdout || '').split(/\r?\n/).filter(line => /VGA|3D controller|Display controller/i.test(line));
    } else {
      throw new Error(`GPU adapter detection is unavailable on ${platform}`);
    }
    if (!devices.length) throw new Error('No GPU adapter names were returned');
    return { gpuVendor: devices.some(name => /nvidia/i.test(name)) ? 'nvidia' : 'any', devices };
  } catch (error) {
    return { gpuVendor: 'any', devices: [],
      warning: `GPU detection unavailable (${error.message}); defaulting to Vulkan. Use --variant cuda12 or --variant vulkan to select explicitly.` };
  }
}
