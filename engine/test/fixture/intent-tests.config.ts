// Self-test app: the static demo clinic in ./site, served on a local port. Its login is a plain form (no
// login API), so sessions log in through their steps.
import { fileURLToPath } from 'node:url';
import { defineConfig } from '../../src/index.ts';

const PORT = Number(process.env.PORT || 4173);

export default defineConfig({
  auth: 'ui',
  webServer: {
    // The static site plus a claim API every browser window shares (see ../fixture-server.ts).
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('../fixture-server.ts', import.meta.url)))}`,
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
  },
});
