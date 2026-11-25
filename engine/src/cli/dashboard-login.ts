// stdout is intentionally the validated token for shell substitution; all prompts go to stderr.
import './node-check.ts';
import { spawn } from 'node:child_process';
import { authorizeRunner } from '../dashboard/auth.ts';
import { APPS_DIR } from '../app.ts';
import { reportingDashboard } from '../dashboard/catalog.ts';
const args = process.argv.slice(2);
try {
  if (args.some((arg) => arg !== '--no-open')) throw Error('Usage: intent-test login [--no-open]');
  const dashboard = reportingDashboard(APPS_DIR)?.url;
  if (!dashboard)
    throw Error(
      'No dashboard to log in to: set AT_DASHBOARD_URL, or "dashboard" in intent-workspace.json.',
    );
  let token = process.env.AT_DASHBOARD_TOKEN?.trim();
  if (!token) {
    const url = dashboard + '/settings?tab=users';
    process.stderr.write('Create a personal access token at ' + url + '\n');
    if (!args.includes('--no-open')) {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        return undefined;
      });
      child.unref();
    }
    process.stderr.write('Paste personal access token (input hidden): ');
    if (process.stdin.isTTY) {
      token = await new Promise<string>((resolve, reject) => {
        let input = '';
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const finish = (error?: Error) => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', receive);
          process.stderr.write('\n');
          if (error) reject(error);
          else resolve(input.trim());
        };
        const receive = (bytes: Buffer) => {
          for (const ch of bytes.toString('utf8')) {
            if (ch === '\u0003') return finish(Error('Cancelled'));
            if (ch === '\r' || ch === '\n') return finish();
            if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
            else if (ch >= ' ') input += ch;
          }
        };
        process.stdin.on('data', receive);
      });
    } else {
      let input = '';
      for await (const bytes of process.stdin) input += bytes.toString();
      token = input.trim();
      process.stderr.write('\n');
    }
  }
  await authorizeRunner(dashboard, { ...process.env, AT_DASHBOARD_TOKEN: token });
  process.stdout.write(token + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
