// Seeds of the self-test app. `fixture base` creates nothing: it reports the base URL seeds are given, so the
// develop-session test can check that a base chosen for the session reaches seeds too.
import type { Seed } from '../../src/seeds.ts';

export const seeds: Record<string, Seed> = {
  'fixture base': {
    description: 'Reports the base URL seeds use; creates nothing',
    async run(ctx) {
      ctx.log(`base ${ctx.baseURL}`);
      return { vars: { base: ctx.baseURL } };
    },
  },
};
