// `intent-test parse --app <name> [file-or-folder]`: validates an app's test files without a browser or a decision model.
import './node-check.ts';

// --app has to be applied before parse-main.ts is loaded: its imports read the app's config while loading.
const { appDir, takeAppArg } = await import('../app.ts');
process.argv = [...process.argv.slice(0, 2), ...takeAppArg(process.argv.slice(2))];
try {
  appDir();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
await import('./parse-main.ts');
