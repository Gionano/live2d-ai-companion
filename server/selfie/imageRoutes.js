import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { normalizeAutoCloseSeconds } from './config.js';

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/i;

export function isLoopbackAddress(address) {
  if (net.isIP(address) === 4) return address.startsWith('127.');
  if (net.isIP(address) !== 6) return false;
  try {
    const normalized = new URL(`http://[${address}]`).hostname;
    return normalized === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(normalized);
  } catch {
    return false;
  }
}

function headerValues(value) {
  return typeof value === 'string' ? value.split(',').map(part => part.trim()) : [];
}

export function isLocalImageRequest(req) {
  const peer = req.socket.remoteAddress || '';
  if (!isLoopbackAddress(peer)) return false;
  // Only loopback peers may supply a forwarded chain. Every hop must be local:
  // an untrusted caller cannot hide behind a forged first address.
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded === undefined || headerValues(forwarded).length > 0
    && headerValues(forwarded).every(isLoopbackAddress);
}

function hasAllowedHost(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost === undefined || !isLoopbackAddress(req.socket.remoteAddress || '')) return true;
  const hosts = headerValues(forwardedHost);
  return hosts.length > 0 && hosts.every(host => LOCAL_HOST.test(host));
}

function isSameOriginSettingsRequest(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'none';
  try {
    const parsed = new URL(origin);
    const forwardedHosts = headerValues(req.headers['x-forwarded-host']);
    const forwardedProtocols = headerValues(req.headers['x-forwarded-proto']);
    const host = forwardedHosts.at(-1) || req.headers.host;
    const protocol = forwardedProtocols.at(-1) || (req.socket.encrypted ? 'https' : 'http');
    return ['http', 'https'].includes(protocol) && parsed.origin === origin
      && origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

export function installSelfieImagePolicy(app, manager) {
  app.use(['/api/selfies', '/selfies'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const name of res.getHeaderNames()) {
      if (String(name).toLowerCase().startsWith('access-control-')) res.removeHeader(name);
    }
    if (!hasAllowedHost(req) || manager.config.allowLan !== true && !isLocalImageRequest(req)) {
      return res.status(403).json({ error: 'Akses hanya diizinkan dari localhost' });
    }
    if (req.baseUrl.toLowerCase() === '/api/selfies' && /^\/settings\/?$/i.test(req.path)
      && (!isLocalImageRequest(req) || !isSameOriginSettingsRequest(req))) {
      return res.status(403).json({ error: 'Akses hanya diizinkan dari origin yang sama di localhost' });
    }
    next();
  });
}

export function installSelfieImageRoutes(app, manager) {
  installSelfieImagePolicy(app, manager);
  // Enabled describes server capability; per-connection feature toggles use WebSocket.
  // Filesystem configuration is private to the server and desktop main process.
  app.get('/api/selfies/settings', (req, res) => {
    res.json({ enabled: true, autoCloseSeconds: normalizeAutoCloseSeconds(manager.config.autoCloseSeconds) });
  });
  // Keep the direct route as an alias; all events publish the proxied API route.
  app.get(['/api/selfies/:token', '/selfies/:token'], (req, res) => {
    const item = manager.getFileByToken(req.params.token);
    if (!item?.filePath) {
      return res.status(404).json({ error: 'Foto selfie tidak ditemukan atau token tidak valid' });
    }

    let target;
    try {
      const outputDir = fs.realpathSync(manager.config.outputDir);
      target = fs.realpathSync(item.filePath);
      const relative = path.relative(outputDir, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return res.status(403).json({ error: 'Akses path tidak diizinkan' });
      }
      if (!fs.statSync(target).isFile()) return res.status(404).end();
    } catch {
      return res.status(404).json({ error: 'File tidak ada di disk' });
    }

    const mimeType = IMAGE_TYPES[path.extname(target).toLowerCase()];
    if (!mimeType) return res.status(403).json({ error: 'Format gambar tidak diizinkan' });
    res.setHeader('Content-Type', mimeType);
    res.sendFile(target, { cacheControl: false, lastModified: false, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 500).end();
    });
  });
}
