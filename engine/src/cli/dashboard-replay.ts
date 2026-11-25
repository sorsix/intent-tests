import './node-check.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeRunner } from '../dashboard/auth.ts';
import { DashboardClient } from '../dashboard/client.ts';
import { runBanner } from '../dashboard/options.ts';
import { loadSession } from '../dashboard/session.ts';
import { atomicJson } from '../dashboard/spool.ts';
import { loadSharedEnv } from '../env.ts';

export type ReplayOptions = {
  authorize?: (dashboard: string) => Promise<unknown>;
  clientFactory?: (url: string) => DashboardClient;
};
export async function replay(
  argv: string[],
  {
    authorize = (dashboard: string) => authorizeRunner(dashboard),
    clientFactory = (url: string) => new DashboardClient(url),
  }: ReplayOptions = {},
): Promise<number> {
  const args = [...argv],
    dir = args.shift();
  if (!dir || args.length) throw new Error('Usage: intent-test replay <spool-directory>');
  // A spool records the dashboard it was made for; replay sends it there.
  const suitePublish = join(dir, 'suite-publish.json');
  const url = existsSync(suitePublish)
    ? String((JSON.parse(readFileSync(suitePublish, 'utf8')) as { url?: unknown }).url ?? '')
    : loadSession(dir).manifest.url;
  if (!url) throw new Error(`${dir} records no dashboard URL to replay to.`);
  await authorize(url);
  const client = clientFactory(url);
  if (existsSync(suitePublish)) {
    if (!existsSync(join(dir, 'ack', 'suite.json'))) {
      await client.publishSuite(JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8')));
      atomicJson(join(dir, 'ack', 'suite.json'), { acknowledgedAt: new Date().toISOString() });
    }
    console.log('Suite replay complete.');
    return 0;
  }
  const session = loadSession(dir, url);
  session.client = client;
  let complete = false;
  for (let attempt = 0; attempt < 3 && !complete; attempt++) {
    complete = await session.pump();
    if (!complete && attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  if (!session.manifest.finished) complete = false;
  if (session.runId) {
    const name =
      session.spool.events(true).find((event) => event.type === 'run.started')?.displayName ||
      session.manifest.envelope.app.name;
    console.log(
      runBanner({
        dashboard: url,
        runId: session.runId,
        runNumber: session.runNumber,
        name: String(name),
      }),
    );
  }
  console.log(
    complete
      ? `Dashboard replay complete${session.runId ? `: ${session.runId}` : ''}`
      : 'Dashboard upload remains pending; spool retained.',
  );
  return complete ? 0 : 1;
}
/** `intent-test replay <spool-directory>`: loads the shared env file, replays, and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  try {
    loadSharedEnv();
    return await replay(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
