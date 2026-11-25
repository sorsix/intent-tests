// Zero-dependency static file server. Serves the current directory by default;
// `intent-test serve <folder>` serves another folder, e.g. a reports folder (opens report.html).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const PORT = Number(process.env.PORT || 4173);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path === '/' && ROOT.endsWith('reports')) path = '/report.html';
  else if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    // ?delay=<ms> (at most 10 s) answers late, for fixture pages that load data slowly (the self-test).
    const delay = Math.min(
      Number(new URL(req.url ?? '/', 'http://x').searchParams.get('delay')) || 0,
      10_000,
    );
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/`);
});
