// One suite invocation: parallel tests followed by exclusive tests, with required authenticated dashboard reporting.
import './node-check.ts';
import { authorizeRunner } from '../dashboard/auth.ts';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  launcherInstallationId,
  RUN_PURPOSES,
  runAnnouncement,
  runBanner,
  runName,
  runPurpose,
} from '../dashboard/options.ts';
import {
  allowOutdatedFromEnvironment,
  checkEngineVersion,
  isReleaseVersion,
} from '../dashboard/engine-version.ts';
import type { EngineCheck, EnginePolicy } from '../dashboard/engine-version.ts';
import type { DashboardSession } from '../dashboard/session.ts';
import type { Manifest } from '../dashboard/spool.ts';
import type {
  PlannedStep,
  RunReportingEvent,
  RunSettingsEvent,
  RunStartedEvent,
  TestRegisteredEvent,
} from '../dashboard/events.ts';

export type ChildResult = {
  code: number;
  signal: NodeJS.Signals | string | null;
  stdout?: string;
  stderr?: string;
};
/** Runs (or, with `list`, lists) one Playwright project of the suite in a child process. */
export type Execute = (
  project: string,
  args: string[],
  env: Record<string, string>,
  list: boolean,
) => Promise<ChildResult>;
export type RunSuiteOptions = {
  execute?: Execute;
  authorize?: (
    dashboard: string,
    environment: NodeJS.ProcessEnv,
    request: typeof fetch,
    product: string,
  ) => Promise<EnginePolicy | undefined | void>;
  createSession?: (dir: string, manifest: Manifest) => DashboardSession;
};
// What discovery (src/dashboard/reporter.ts) writes per phase into AT_DASHBOARD_DISCOVERY_DIR.
type DiscoveryEntry = Omit<TestRegisteredEvent, 'id' | 'type' | 'ts' | 'plan'> & {
  plan: PlannedStep[];
};
type DiscoveryPlan = { tests?: number; stepsTotal?: number; entries?: DiscoveryEntry[] };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

let activeChild: ChildProcess | undefined;
export const executeChild: Execute = async (project, args, env, list) => {
  const { ENGINE_DIR } = await import('../app.ts');
  const executable = join(
    createRequire(import.meta.url).resolve('playwright/package.json'),
    '..',
    'cli.js',
  );
  const configFile = existsSync(join(ENGINE_DIR, 'playwright.intent.config.js'))
    ? 'playwright.intent.config.js'
    : 'playwright.intent.config.ts';
  return new Promise<ChildResult>((resolveResult) => {
    // No TTY stdin: Playwright then skips its "show-report" hint, whose path is relative to ENGINE_DIR (see printReportCommands).
    const child = spawn(
      process.execPath,
      [
        executable,
        'test',
        '-c',
        join(ENGINE_DIR, configFile),
        `--project=${project}`,
        ...args,
        ...(list ? ['--list'] : []),
      ],
      {
        cwd: ENGINE_DIR,
        env: { ...process.env, ...env },
        stdio: list ? ['inherit', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      },
    );
    activeChild = child;
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (bytes: Buffer) => {
      stdout += bytes;
    });
    child.stderr?.on('data', (bytes: Buffer) => {
      stderr += bytes;
    });
    child.once('error', (error) =>
      resolveResult({ code: 1, signal: null, stdout, stderr: error.message }),
    );
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      resolveResult({ code: code ?? 1, signal, stdout, stderr });
    });
  });
};

// Commands to open each phase's reports, relative to the caller's directory (the consumer workspace).
function printReportCommands(ran: { phase: string; dir: string }[]) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const shown = (path: string) => {
    const short = relative(process.cwd(), path);
    return short.startsWith('..') ? path : short;
  };
  const lines: string[] = [];
  for (const { phase, dir } of ran) {
    const report = join(dir, 'report.html'),
      playwright = join(dir, 'playwright');
    if (existsSync(report)) lines.push(`  ${opener} ${shown(report)}   # ${phase}: intent report`);
    if (existsSync(playwright))
      lines.push(
        `  npx playwright show-report ${shown(playwright)}   # ${phase}: Playwright report`,
      );
  }
  if (lines.length) console.log(`\nOpen the reports:\n${lines.join('\n')}`);
}

export async function runSuite(
  argv: string[],
  { execute = executeChild, authorize = authorizeRunner, createSession }: RunSuiteOptions = {},
): Promise<number> {
  const { appDir, reportDir, takeAppArg } = await import('../app.ts');
  let args = takeAppArg(argv),
    allowOutdated = false;
  const selected: string[] = [],
    rest: string[] = [],
    caseIds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--allow-outdated') allowOutdated = true;
    else if (argument === '--case-id') {
      const id = args[++index];
      if (!id || id.startsWith('--')) throw new Error('--case-id requires an exact case ID');
      caseIds.push(id);
    } else if (argument.startsWith('--case-id=')) {
      const id = argument.slice(10);
      if (!id) throw new Error('--case-id requires an exact case ID');
      caseIds.push(id);
    } else if (argument === '--purpose' || argument.startsWith('--purpose=')) {
      const value = argument === '--purpose' ? args[++index] : argument.slice(10);
      if (!(RUN_PURPOSES as readonly string[]).includes(value))
        throw new Error(`--purpose must be ${RUN_PURPOSES.join(' or ')}`);
      process.env.AT_RUN_PURPOSE = value;
    } else if (argument === '--project') selected.push(args[++index]);
    else if (argument.startsWith('--project=')) selected.push(argument.slice(10));
    else rest.push(argument);
  }
  if (caseIds.length) process.env.AT_CASE_IDS = caseIds.join(',');
  args = rest;
  if (selected.some((project) => !['parallel', 'exclusive'].includes(project)))
    throw new Error('--project must be parallel or exclusive');
  const phases = ['parallel', 'exclusive'].filter(
    (phase) => !selected.length || selected.includes(phase),
  );
  const app = appDir();
  const gitValue = (arguments_: string[]) => {
    try {
      return execFileSync('git', arguments_, {
        cwd: app,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
    } catch {
      return '';
    }
  };
  const { loadEnv } = await import('../env.ts');
  loadEnv();
  console.log(`App: ${app}`);
  const reports = reportDir(),
    listOnly = args.includes('--list');
  let engine: EngineCheck | undefined;
  const { reportingIdentity, reportingTarget } = await import('../dashboard/catalog.ts');
  // Listing needs no dashboard, so it also needs no product. Without a dashboard URL, token or product the run is
  // local only; a token or product without a URL stops here (reportingTarget).
  const target = listOnly ? undefined : reportingTarget(app);
  const identity = target ? reportingIdentity(process.env.AT_APP || basename(app), app) : null;
  if (!listOnly && !target)
    console.log(
      'Local run: not reported to a dashboard (set AT_DASHBOARD_URL, or "dashboard" in intent-workspace.json, to report).',
    );
  if (identity && target) {
    engine = checkEngineVersion(
      (await authorize(target.url, process.env, fetch, identity.project.key)) || undefined,
      allowOutdated || allowOutdatedFromEnvironment(),
    );
    if (engine.warning) console.warn(`Warning: ${engine.warning}`);
  }
  let purpose: ReturnType<typeof runPurpose>;
  if (identity) {
    const { appConfig } = await import('../app-config.ts');
    purpose = runPurpose(process.env, appConfig.purpose);
  }
  const discovery = listOnly ? '' : mkdtempSync(join(tmpdir(), 'intent-dashboard-discovery-'));
  const cleanEnvironment = { AT_DASHBOARD_SPOOL_DIR: '', AT_DASHBOARD_DISCOVERY_DIR: '' };
  let cancelled = false,
    session: DashboardSession | undefined,
    interval: ReturnType<typeof setInterval> | undefined,
    code = 0;
  let linkPrinted = false,
    displayName = '';
  const phaseLinksPrinted = new Set<string>();
  // The machine-readable line for tools that start the engine (Launcher): once the run is registered and again when
  // its number becomes known, always before the human banner.
  let announced = '';
  const announce = (runId: string, runNumber: number | null) => {
    const line = runAnnouncement({ dashboard: target!.url, runId, runNumber });
    if (line !== announced) console.log((announced = line));
  };
  const printLink = (phase?: string) => {
    if (!session?.runId) return;
    announce(session.runId, session.runNumber);
    if (phase ? phaseLinksPrinted.has(phase) : linkPrinted) return;
    if (phase) phaseLinksPrinted.add(phase);
    else linkPrinted = true;
    console.log(
      runBanner({
        dashboard: target!.url,
        runId: session.runId,
        runNumber: session.runNumber,
        name: displayName,
      }),
    );
  };
  const startedAt = Date.now(),
    ran: { phase: string; dir: string }[] = [];
  const cancel = (signal: NodeJS.Signals) => {
    cancelled = true;
    activeChild?.kill(signal);
  };
  const interrupt = () => cancel('SIGINT'),
    terminate = () => cancel('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const runnable: string[] = [],
      planned: Record<string, number> = {},
      entries: Record<string, DiscoveryEntry[]> = {};
    for (const phase of phases) {
      if (cancelled) break;
      const listed = await execute(
        phase,
        args,
        {
          ...cleanEnvironment,
          AT_REPORT_DIR: phase === 'exclusive' ? join(reports, 'exclusive') : reports,
          AT_DASHBOARD_PHASE: phase,
          AT_DASHBOARD_DISCOVERY_DIR: discovery,
        },
        true,
      );
      if (listOnly) {
        if (listed.stdout) console.log(listed.stdout.trim());
        if (listed.stderr) console.error(listed.stderr.trim());
        code ||= listed.code;
        continue;
      }
      const output = `${listed.stdout ?? ''}${listed.stderr ?? ''}`;
      const emptySelection =
        /No tests found/.test(output) &&
        !/Error:(?!\s*No tests found)/.test(output) &&
        !listed.signal;
      if (listed.code !== 0 && !emptySelection) {
        console.error(
          `\n[${phase}] could not list the tests:\n${output.trim() || 'Playwright failed to start'}`,
        );
        code = 1;
        if (listed.signal) break;
        continue;
      }
      let plan: DiscoveryPlan | undefined;
      const path = discovery ? join(discovery, `${phase}.json`) : '';
      if (path && existsSync(path)) plan = JSON.parse(readFileSync(path, 'utf8')) as DiscoveryPlan;
      if (!/\btests\.spec\.[jt]s\b/.test(listed.stdout ?? '') && !plan?.tests) {
        console.log(`\n[${phase}] no tests to run`);
        continue;
      }
      runnable.push(phase);
      planned[phase] = plan?.stepsTotal ?? 0;
      entries[phase] = plan?.entries || [];
    }
    if (listOnly) return cancelled ? 130 : code;
    if (identity && target && runnable.length && !cancelled) {
      try {
        const { DashboardSession } = await import('../dashboard/session.ts');
        const { captureSuite } = await import('../dashboard/catalog.ts');
        const { atomicJson } = await import('../dashboard/spool.ts');
        const suite = await captureSuite(app, process.env.AT_DASHBOARD_SUITE_REVISION);
        const runId = randomUUID(),
          dir = join(reports, 'dashboard', runId),
          phaseReports: Record<string, string> = {};
        for (const phase of runnable) {
          phaseReports[phase] = join(dir, 'reports', phase);
          mkdirSync(phaseReports[phase], { recursive: true });
        }
        const manifest: Manifest = {
          version: 1,
          reportingProtocol: 1,
          url: target.url,
          envelope: { ...identity, clientRunId: runId },
          createdAt: new Date(startedAt).toISOString(),
          reports: phaseReports,
          planned,
        };
        const created = createSession
          ? createSession(dir, manifest)
          : new DashboardSession(dir, manifest);
        session = created;
        atomicJson(join(dir, 'suite.json'), { ...identity, suite });
        displayName = runName(`${manifest.envelope.app.name} intent suite`);
        const { environmentBuild, environmentBuildMessage } =
          await import('../dashboard/environment-build.ts');
        const build = await environmentBuild();
        const linked = build && environmentBuildMessage(build);
        if (linked) console.log(linked);
        session.spool.event({
          id: 'parent:started',
          type: 'run.started',
          ts: manifest.createdAt,
          ...(build ? { environmentBuildId: build.id } : {}),
          ...(purpose ? { purpose } : {}),
          ...(launcherInstallationId() ? { launcherInstallationId: launcherInstallationId() } : {}),
          displayName,
          environment: process.env.AT_DASHBOARD_ENVIRONMENT || process.env.AT_ENV || 'dev',
          branch:
            process.env.AT_DASHBOARD_BRANCH ||
            process.env.GITHUB_REF_NAME ||
            process.env.CI_COMMIT_REF_NAME ||
            gitValue(['branch', '--show-current']) ||
            'local',
          commitSha:
            process.env.AT_DASHBOARD_COMMIT_SHA ||
            process.env.GITHUB_SHA ||
            process.env.CI_COMMIT_SHA ||
            gitValue(['rev-parse', 'HEAD']),
          triggeredBy:
            process.env.AT_DASHBOARD_TRIGGERED_BY ||
            (process.env.CI ? 'CI' : process.env.USER || 'developer'),
          ...(engine && isReleaseVersion(engine.version)
            ? { engine: { version: engine.version, allowOutdated: engine.allowOutdated } }
            : {}),
          settings: {
            phases: runnable,
            suiteHash: suite.suiteHash,
            ...(suite.revision ? { suiteRevision: suite.revision } : {}),
            runner: {
              app: process.env.AT_APP || basename(app),
              environmentProfile: process.env.AT_ENV || 'dev',
              appDir: relative(process.cwd(), app),
            },
            selection: {
              caseIds: (process.env.AT_CASE_IDS || '').split(/[\s,]+/).filter(Boolean),
              testsFilter: process.env.AT_TESTS || null,
              ...(process.env.AT_PARAMS
                ? {
                    params: process.env.AT_PARAMS.split(',')
                      .map((key) => key.trim())
                      .filter(Boolean),
                  }
                : {}),
            },
          },
        } satisfies RunStartedEvent);
        for (const phase of runnable)
          for (const entry of entries[phase])
            session.spool.event({
              id: `parent:${phase}:${entry.clientTestId}:register`,
              type: 'test.registered',
              ...entry,
              attempt: 1,
              stepsTotal: entry.plan.length,
            } satisfies TestRegisteredEvent);
        session.spool.event({
          id: 'parent:reporting:1',
          type: 'run.reporting',
          seq: 1,
          status: 'uploading',
        } satisfies RunReportingEvent);
        if (!(await created.pump()) || !created.runId)
          throw new Error(
            'The run and suite could not be registered. Tests were not started; the spool is retained at ' +
              dir,
          );
        printLink();
        interval = setInterval(() => {
          void created.pump().then(() => printLink());
        }, 1000);
        console.log(`Dashboard spool: ${dir}\nLocal reports: ${join(dir, 'reports')}`);
      } catch (error) {
        throw new Error(`Dashboard registration failed. ${message(error)}`);
      }
    }
    for (const phase of runnable) {
      if (cancelled) break;
      const phaseArgs =
        phase === 'exclusive'
          ? args
              .filter(
                (argument, index) =>
                  argument !== '--workers' &&
                  !argument.startsWith('--workers=') &&
                  args[index - 1] !== '--workers',
              )
              .concat('--workers=1')
          : args;
      const env = {
        ...cleanEnvironment,
        AT_DASHBOARD_PHASE: phase,
        AT_REPORT_DIR:
          session?.manifest.reports[phase] ||
          (phase === 'exclusive' ? join(reports, 'exclusive') : reports),
        ...(session ? { AT_DASHBOARD_SPOOL_DIR: session.dir, AT_LOG_DECISIONS: 'true' } : {}),
      };
      if (session) {
        try {
          session.spool.event({
            id: `parent:active-phase:${phase}`,
            type: 'run.settings',
            settings: { activePhase: phase },
          } satisfies RunSettingsEvent);
          await session.pump();
          printLink();
        } catch (error) {
          console.warn(
            `Dashboard phase reporting pending; test execution continues. ${message(error)}`,
          );
        }
      }
      console.log(`\n[${phase}] running…`);
      printLink(phase);
      const result = await execute(phase, phaseArgs, env, false);
      ran.push({ phase, dir: resolve(env.AT_REPORT_DIR) });
      code ||= result.code;
      if (result.signal && !cancelled) {
        code = 1;
        break;
      }
    }
    if (interval) clearInterval(interval);
    if (session) {
      try {
        const complete = await session.finish(
          cancelled ? 'cancelled' : code ? 'failed' : undefined,
          Date.now() - startedAt,
        );
        printLink();
        if (!complete) {
          code ||= 1;
          console.warn(
            `Dashboard upload remains pending. Replay: intent-test replay "${session.dir}"`,
          );
        }
      } catch (error) {
        code ||= 1;
        console.warn(`Dashboard finalization pending; spool retained. ${message(error)}`);
      }
    }
    printReportCommands(ran);
    return cancelled ? 130 : code ? 1 : 0;
  } finally {
    if (interval) clearInterval(interval);
    if (discovery) rmSync(discovery, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runSuite(process.argv.slice(2));
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}
