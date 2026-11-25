import { join } from 'node:path';
import { reportDir } from './app.ts';
import { sessionSlug } from './parse.ts';

/** Where a session's browser state (cookies + localStorage) is stored for this run. */
export const sessionFile = (name: string) =>
  join(reportDir(), '.auth', `${sessionSlug(name)}.json`);
