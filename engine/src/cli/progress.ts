// Prints a one-line progress report every 30 s from the progress.json the reporter writes while a run is going:
// steps done, tests finished and failed (with the step they stopped at), and an ETA.
// Usage: intent-test progress --app <name> [intervalSec=30]   (AT_REPORT_DIR=<dir> reads another report folder)
// Exits when the run is finished. Reads <dir>/progress.json and, for the @exclusive pass, <dir>/exclusive/progress.json.
import './node-check.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { reportDir, takeAppArg } = await import('../app.ts');
const args = takeAppArg(process.argv.slice(2));
const dir = reportDir();
const everySec = Number(args[0] ?? 30);
const files = [join(dir, 'progress.json'), join(dir, 'exclusive', 'progress.json')];
const started = Date.now();
const reported = new Set<string>();
// The parts of the reporter's progress.json read here (src/reporter.ts).
type Progress = {
  startedAt: string;
  state: string;
  elapsedSec: number;
  etaSec: number | null;
  steps: { done: number; remaining: number };
  tests: { finished: number; total: number; failed: number };
  running: { title: string; stepsDone: number; stepsTotal?: number; current?: string }[];
  failed: { title: string; failedStep?: string; error?: string }[];
};

const dur = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
      : `${Math.round(s)}s`;
const read = (f: string): Progress | null => {
  try {
    return existsSync(f) &&
      Date.parse(JSON.parse(readFileSync(f, 'utf8')).startedAt) >= started - 60_000
      ? (JSON.parse(readFileSync(f, 'utf8')) as Progress)
      : null;
  } catch {
    return null; // being rewritten
  }
};

for (;;) {
  const runs = files.map(read).filter((p) => p !== null);
  if (!runs.length)
    console.log(`[${dur((Date.now() - started) / 1000)}] waiting for the run to start…`);
  for (const p of runs) {
    const total = p.steps.done + p.steps.remaining;
    const pct = total ? Math.round((100 * p.steps.done) / total) : 0;
    const now = p.running
      .map(
        (r) =>
          `${r.title.slice(0, 40)} ${r.stepsDone}/${r.stepsTotal || '?'}${r.current ? ` (${r.current.slice(0, 60)})` : ''}`,
      )
      .join(' | ');
    console.log(
      `[${dur(p.elapsedSec)}] ${p.steps.done}/${total} steps (${pct}%) · tests ${p.tests.finished}/${p.tests.total} done, ${p.tests.failed} failed · ETA ${p.state === 'finished' ? 'done' : p.etaSec == null ? 'unknown yet' : `~${dur(p.etaSec)}`}${now ? ` · now: ${now}` : ''}`,
    );
    for (const f of p.failed) {
      const key = `${f.title}|${f.failedStep}`;
      if (reported.has(key)) continue;
      reported.add(key);
      console.log(`  ✘ FAILED: ${f.title} ${f.failedStep ?? ''}${f.error ? ` — ${f.error}` : ''}`);
    }
  }
  // The @exclusive pass starts right after the parallel one: give its progress file a moment to appear.
  if (
    runs.length &&
    runs.every((p) => p.state === 'finished') &&
    (await new Promise((r) => setTimeout(r, 8000)),
    files
      .map(read)
      .filter((p) => p !== null)
      .every((p) => p.state === 'finished'))
  ) {
    console.log(
      `FINISHED: ${runs.map((p) => `${p.tests.finished - p.tests.failed} passed, ${p.tests.failed} failed`).join(' / ')}`,
    );
    break;
  }
  await new Promise((r) => setTimeout(r, everySec * 1000));
}
