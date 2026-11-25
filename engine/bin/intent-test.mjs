#!/usr/bin/env node
import { existsSync } from 'node:fs';

// The published package runs the compiled dist/. A source checkout without a build runs src/ directly, which needs
// Node 22.18+ (it strips the TypeScript); after a build, dist/ wins, so rebuild after changing the source.
const compiled = existsSync(new URL('../dist/src/cli/node-check.js', import.meta.url));
const cli = (name) =>
  new URL(compiled ? `../dist/src/cli/${name}.js` : `../src/cli/${name}.ts`, import.meta.url).href;
await import(cli('node-check'));

const [command = 'help', ...args] = process.argv.slice(2);
const commands = {
  catalog: 'catalog',
  develop: 'develop',
  ids: 'ids',
  login: 'dashboard-login',
  parse: 'parse',
  'parse-all': 'parse-all',
  progress: 'progress',
  'publish-suite': 'publish-suite',
  replay: 'dashboard-replay',
  serve: 'serve',
};

if (['help', '--help', '-h'].includes(command)) {
  console.log(
    'Intent Engine\n\nUsage: intent-engine <run|parse|parse-all|ids|catalog|develop|progress|login|publish-suite|replay|serve> [arguments]\n\nRun from your application workspace (apps in ./intent-tests/<app>) or from a test folder with intent-workspace.json.\nSet AT_APPS_DIR or AT_APP_DIR to select another location.\nExample: intent-engine parse --app clinic',
  );
} else if (['--version', '-v'].includes(command)) {
  const { readFileSync } = await import('node:fs');
  console.log(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
} else if (command === 'run') {
  try {
    const { runSuite } = await import(cli('run-suite'));
    process.exitCode = await runSuite(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (command === 'ids') {
  // Like replay: its module exports main, and a plain import would not start it.
  const { main } = await import(cli(commands.ids));
  process.exitCode = main(args);
} else if (command === 'develop') {
  // Exports main like replay; it exits itself once the browser is closed.
  const { main } = await import(cli(commands.develop));
  process.exit(await main(args));
} else if (command === 'replay') {
  // Its module runs only as the main script, so call it: the generic import below would not start it.
  const { main } = await import(cli(commands.replay));
  process.exitCode = await main(args);
} else if (Object.hasOwn(commands, command)) {
  process.argv = [process.argv[0], process.argv[1], ...args];
  await import(cli(commands[command]));
} else {
  console.error(`Unknown Intent Engine command: ${command}. Run intent-engine --help.`);
  process.exitCode = 1;
}
