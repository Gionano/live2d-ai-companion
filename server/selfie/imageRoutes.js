import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

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
    next();
  });
}

export function installSelfieImageRoutes(app, manager) {
  installSelfieImagePolicy(app, manager);
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
