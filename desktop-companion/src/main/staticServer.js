import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.moc3': 'application/octet-stream',
  '.physics3.json': 'application/json; charset=utf-8',
  '.model3.json': 'application/json; charset=utf-8',
  '.motion3.json': 'application/json; charset=utf-8',
  '.exp3.json': 'application/json; charset=utf-8',
  '.cdi3.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * Menjalankan server statis lokal (127.0.0.1) untuk menyajikan build statis frontend
 * dari folder resources/frontend-dist pada mode produksi, sekaligus mem-proxy
 * request /api dan upgrade WebSocket /ws ke backend lokal.
 */
export function startProductionStaticServer(staticRootDir) {
  return new Promise((resolve, reject) => {
    const backendParsed = new URL(CONFIG.backendUrl);
    const backendHost = backendParsed.hostname || '127.0.0.1';
    const backendPort = Number(backendParsed.port) || 8787;

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

        // Proxy /api/* ke backend
        if (reqUrl.pathname.startsWith('/api')) {
          const proxyReq = http.request(
            {
              hostname: backendHost,
              port: backendPort,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
              proxyRes.pipe(res, { end: true });
            },
          );
          proxyReq.on('error', (err) => {
            logger.error('StaticServer', 'Proxy /api error', { error: err.message });
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: 'Backend unreachable' }));
          });
          req.pipe(proxyReq, { end: true });
          return;
        }

        // Sajikan file statis dari folder resources/frontend-dist
        let decodedPath = decodeURIComponent(reqUrl.pathname);
        if (decodedPath === '/') decodedPath = '/index.html';

        const safePath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
        let filePath = path.join(staticRootDir, safePath);

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          filePath = path.join(staticRootDir, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, content) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        });
      } catch (err) {
        logger.error('StaticServer', 'Error melayani file statis', { error: err.message });
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    // Proxy WebSocket upgrade (/ws) ke backend
    server.on('upgrade', (req, socket, head) => {
      const proxySocket = http.request({
        hostname: backendHost,
        port: backendPort,
        path: req.url,
        method: 'GET',
        headers: req.headers,
      });

      proxySocket.on('upgrade', (proxyRes, remoteSocket, remoteHead) => {
        let rawHeaders = `HTTP/1.1 101 Switching Protocols\r\n`;
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) rawHeaders += `${k}: ${item}\r\n`;
          } else if (v !== undefined) {
            rawHeaders += `${k}: ${v}\r\n`;
          }
        }
        rawHeaders += '\r\n';
        socket.write(rawHeaders);
        if (remoteHead && remoteHead.length) socket.write(remoteHead);
        if (head && head.length) remoteSocket.write(head);
        remoteSocket.pipe(socket);
        socket.pipe(remoteSocket);
      });

      proxySocket.on('error', (err) => {
        logger.error('StaticServer', 'Proxy WebSocket error', { error: err.message });
        socket.destroy();
      });

      proxySocket.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      logger.info('StaticServer', 'Server statis produksi berjalan', {
        url,
        staticRootDir,
      });
      resolve({ server, url });
    });

    server.on('error', reject);
  });
}
