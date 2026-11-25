// The self-test's demo clinic server: the static site in fixture/site (like `intent-test serve`), plus one piece of state
// shared by every browser window, for the `switch to window` self-test. Each window has its own localStorage, so the
// app's own data can't show what one user does to another; the claims here can, like a record one user locks.
//   GET    /api/claims         every claim, { "<case>": "<username>" }
//   POST   /api/claims/<case>  claims the case for ?by=<username>; 409 when someone else holds it
//   DELETE /api/claims/<case>  releases it; DELETE /api/claims releases every claim (a test's clean start)
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The site folder: the first argument (the package test serves its installed copy), else the fixture's own.
const ROOT = resolve(process.argv[2] || fileURLToPath(new URL('fixture/site', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

const claims = new Map<string, string>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = decodeURIComponent(url.pathname);
  const claim = path.match(/^\/api\/claims(?:\/(.+))?$/);
  if (claim) {
    const item = claim[1];
    const by = url.searchParams.get('by') ?? '';
    if (req.method === 'GET' && !item) return json(res, 200, Object.fromEntries(claims));
    if (req.method === 'DELETE' && !item) {
      claims.clear();
      return json(res, 200, {});
    }
    if (req.method === 'POST' && item && by) {
      const owner = claims.get(item);
      if (owner && owner !== by)
        return json(res, 409, { message: `${item} is already being read by ${owner}` });
      claims.set(item, by);
      return json(res, 200, { item, by });
    }
    if (req.method === 'DELETE' && item) {
      if (claims.get(item) === by) claims.delete(item);
      return json(res, 200, {});
    }
    return json(res, 400, { message: 'unsupported claim request' });
  }

  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    // ?delay=<ms> (at most 10 s) answers late, for fixture pages that load data slowly.
    const delay = Math.min(Number(url.searchParams.get('delay')) || 0, 10_000);
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
  console.log(`Serving the demo clinic at http://127.0.0.1:${PORT}/`);
});
