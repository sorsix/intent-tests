// `intent-test develop --app <name> [--headed]` (also AT_APP_DIR): develop mode's engine child (docs/develop-mode.md,
// section 3). Newline-delimited JSON: requests on stdin, replies and events on stdout and nothing else there; logs go to
// stderr. Emits `ready` at startup. Exits 0 on stdin EOF, SIGINT or SIGTERM, after closing the browser. No dashboard
// token is needed: develop sessions do not report.
import './node-check.ts';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DevelopMessage } from '../develop/protocol.ts';

const USAGE = 'Usage: intent-test develop --app <name> [--headed]   (or AT_APP_DIR=<path>)';

export async function main(argv: string[]): Promise<number> {
  const { appDir, reportDir, takeAppArg } = await import('../app.ts');
  const args = takeAppArg(argv);
  const headed = args.includes('--headed');
  const unknown = args.find((arg) => arg !== '--headed');
  if (unknown) {
    console.error(`Unknown argument: ${unknown}. ${USAGE}`);
    return 2;
  }

  // Everything the engine prints for people goes to stderr; stdout carries the protocol only.
  const toStderr = (...parts: unknown[]) => console.error(...parts);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  let dir: string;
  try {
    dir = appDir();
    const { loadEnv } = await import('../env.ts');
    loadEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  // Develop sessions keep their own reports folder: decision logs (AT_LOG_DECISIONS=true) go to
  // <app>/reports/develop/decisions/, saved session states to <app>/reports/develop/.auth/.
  process.env.AT_REPORT_DIR = resolve(reportDir(), 'develop');

  const write = (message: DevelopMessage) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const { DevelopSession } = await import('../develop/session.ts');
  const session = new DevelopSession({
    emit: write,
    drained: () =>
      process.stdout.writableNeedDrain
        ? once(process.stdout, 'drain').then(() => undefined)
        : Promise.resolve(),
    log: (line) => console.error(line),
    headed,
    appDir: dir,
    app: process.env.AT_APP || basename(dir),
  });

  let closing: Promise<void> | null = null;
  const shutdown = (why: string) => {
    closing ??= (async () => {
      console.error(`[develop] ${why}: closing the browser`);
      const timeout = new Promise<void>((done) => setTimeout(done, 15_000).unref());
      await Promise.race([session.close(), timeout]);
    })();
    return closing;
  };
  const exitAfter = (why: string) => {
    void shutdown(why).then(() => process.exit(0));
  };
  process.once('SIGINT', () => exitAfter('SIGINT'));
  process.once('SIGTERM', () => exitAfter('SIGTERM'));
  // A client that went away: nothing to answer any more.
  process.stdout.on('error', () => exitAfter('stdout closed'));

  write({ event: 'ready', ...session.ready() });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      write({ event: 'log', level: 'error', message: 'ignored a line that is not JSON' });
      continue;
    }
    const answered = session.receive(request);
    pending.add(answered);
    void answered.finally(() => pending.delete(answered));
  }
  // stdin EOF: let the requests already sent finish, then close.
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((done) => setTimeout(done, 5_000).unref()),
  ]);
  await shutdown('stdin closed');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(await main(process.argv.slice(2)));
