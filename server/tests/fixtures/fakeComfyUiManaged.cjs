const fs = require('node:fs');
const http = require('node:http');

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes('--help')) {
  if (process.env.FAKE_HELP_LOG) fs.appendFileSync(process.env.FAKE_HELP_LOG, 'help\n');
  process.stdout.write('--listen HOST --port PORT --disable-auto-launch --lowvram --reserve-vram GB --known VALUE\n');
  process.exit(0);
}
if (process.env.FAKE_ARGV_LOG) fs.writeFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.FAKE_EXIT) {
  process.stderr.write('FAKE_START_FAILURE_TAIL\n');
  process.exit(7);
}
const log = entry => {
  if (process.env.FAKE_HTTP_LOG) fs.appendFileSync(process.env.FAKE_HTTP_LOG, `${entry}\n`);
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hN8AAAAASUVORK5CYII=', 'base64');
let prompt = null;
let interrupted = false;
const startedAt = Date.now();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  log(`${request.method} ${url.pathname}`);
  response.setHeader('Content-Type', 'application/json');
  const send = (value, code = 200) => { response.statusCode = code; response.end(JSON.stringify(value)); };
  if (url.pathname === (process.env.FAKE_HEALTH_PATH || '/system_stats')) {
    return send({ system: { name: 'fake-managed-comfy' }, devices: [] },
      process.env.FAKE_UNHEALTHY || Date.now() - startedAt < Number(process.env.FAKE_READY_DELAY_MS || 0) ? 503 : 200);
  }
  if (url.pathname === '/object_info') return send(JSON.parse(process.env.FAKE_OBJECT_INFO || '{}'));
  if (url.pathname === '/prompt') {
    let body = '';
    for await (const chunk of request) body += chunk;
    prompt = JSON.parse(body).prompt;
    if (process.env.FAKE_PROMPT_LOG) fs.writeFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify(prompt));
    interrupted = false;
    return send({ prompt_id: 'owned-fake-prompt' });
  }
  if (url.pathname === '/queue') return send({ queue_running: prompt && !interrupted ? [[1, 'owned-fake-prompt']] : [], queue_pending: [] });
  if (url.pathname === '/interrupt') { interrupted = true; return send({}); }
  if (url.pathname === '/free') return send({});
  if (url.pathname === '/upload/image') return send({ name: 'reference.png', subfolder: '', type: 'input' });
  if (url.pathname.startsWith('/history/')) {
    if (process.env.FAKE_SLOW || interrupted || !prompt) return send({});
    const saveId = Object.keys(prompt).find(id => prompt[id]?.class_type === 'SaveImage') || '1';
    return send({ 'owned-fake-prompt': { outputs: { [saveId]: { images: [{ filename: 'fake-selfie.png', subfolder: '', type: 'output' }] } } } });
  }
  if (url.pathname === '/view') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  return send({}, 404);
});
server.listen(Number(option('--port')), option('--listen'), () => {
  process.stdout.write('FAKE_COMFYUI_LISTENING\n');
  if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
});
