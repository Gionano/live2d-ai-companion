const endpoints = [
  'http://127.0.0.1:5173/',
  'http://127.0.0.1:5173/api/config',
  'http://127.0.0.1:5174/',
  'http://127.0.0.1:5174/api/status',
];

try {
  await Promise.all(endpoints.map(async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Service unavailable');
    await response.arrayBuffer();
  }));
} catch {
  process.exitCode = 1;
}
