// Suite capture has no browser/model dependency; publishing can happen before any test execution.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKSPACE_FILE } from '../app.ts';
import { dashboardBaseUrl } from './auth.ts';
import { clientTestId } from '../parse.ts';
import { loadSuite } from '../parameters.ts';
import type { TestCase } from '../parse.ts';
import { sanitize } from './sanitize.ts';
import { digest } from './spool.ts';
import type { Envelope } from './spool.ts';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function caseSnapshot(test: TestCase) {
  const captured = sanitize({
    title: test.name,
    file: test.file,
    line: test.line,
    tags: test.tags,
    // Only when present, so suites without them keep their hashes.
    ...(test.refs.length ? { refs: test.refs } : {}),
    ...(test.draft ? { draft: true as const } : {}),
    session: test.session,
    seed: test.seed,
    stepsTotal: test.steps.length,
    plan: test.steps.map(({ number, label, text, kind, file, line }) => ({
      number,
      label,
      text,
      kind,
      file,
      line,
    })),
  });
  captured.plan = captured.plan.map((step, index) => ({
    ...step,
    number: test.steps[index].number,
    label: test.steps[index].label,
    kind: test.steps[index].kind,
    file: test.steps[index].file,
    line: test.steps[index].line,
  }));
  const intent = {
    title: captured.title,
    tags: captured.tags,
    session: captured.session,
    seed: captured.seed,
    plan: captured.plan.map(({ number, label, text, kind }) => ({ number, label, text, kind })),
  };
  return {
    ...captured,
    file: test.file,
    line: test.line,
    clientTestId: clientTestId(test),
    explicitId: test.explicitId,
    intentHash: digest(canonicalJson(intent)),
    ...(test.template
      ? {
          template: test.template,
          parameters: { ...test.parameters!, values: sanitize(test.parameters!.values) },
        }
      : {}),
  };
}
/** The whole app's catalog, every template expanded into its cases; AT_PARAMS and AT_CASE_IDS do not narrow it. */
export async function captureSuite(app: string, revision?: string) {
  const parsed = await loadSuite(app, null, { params: '', ids: '' });
  const cases = parsed.files.flatMap((file) => file.cases.map(caseSnapshot));
  const sources = parsed.files.map((file) => {
    const content = sanitize(readFileSync(file.path, 'utf8'));
    return { file: file.rel, content, sha256: digest(content) };
  });
  return {
    suiteHash: digest(canonicalJson({ cases, sources })),
    ...(revision ? { revision } : {}),
    cases,
    sources,
  };
}
export type SuitePayload = Pick<Envelope, 'project' | 'app'> & {
  suite: Awaited<ReturnType<typeof captureSuite>>;
};
export { WORKSPACE_FILE };
const PRODUCT_KEY = /^[A-Za-z0-9._-]{1,120}$/;

/** The nearest intent-workspace.json for an app folder (in it or the folder that contains it), parsed. */
function workspaceFile(app: string): { path: string; data: Record<string, unknown> } | undefined {
  for (const directory of [app, dirname(app)]) {
    const path = join(directory, WORKSPACE_FILE);
    if (!existsSync(path)) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
    return {
      path,
      data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    };
  }
  return undefined;
}

/**
 * The dashboard product (a "project" in the reporting protocol) the app reports into: AT_DASHBOARD_PRODUCT_KEY, else the
 * nearest committed intent-workspace.json ({ "product": "<key>" }) in the app folder or the folder that contains it.
 */
export function reportingProduct(
  app: string,
  environment: NodeJS.ProcessEnv = process.env,
): { key: string; source: string } {
  const fromEnvironment = environment.AT_DASHBOARD_PRODUCT_KEY?.trim();
  if (fromEnvironment) return { key: fromEnvironment, source: 'AT_DASHBOARD_PRODUCT_KEY' };
  const file = workspaceFile(app);
  if (file) {
    const product = file.data.product;
    if (typeof product !== 'string' || !PRODUCT_KEY.test(product))
      throw new Error(
        `${file.path} needs a "product" key (letters, digits, . _ -), e.g. { "product": "my-product" }.`,
      );
    return { key: product, source: file.path };
  }
  throw new Error(
    `No ${WORKSPACE_FILE} found for ${app}. Create ${join(dirname(app), WORKSPACE_FILE)} containing { "product": "<key>" } (the key of a product in the dashboard's Products & apps), or set AT_DASHBOARD_PRODUCT_KEY.`,
  );
}

/**
 * The dashboard the app reports to: AT_DASHBOARD_URL, else `dashboard` in the nearest intent-workspace.json; undefined
 * when neither is set.
 */
export function reportingDashboard(
  app: string,
  environment: NodeJS.ProcessEnv = process.env,
): { url: string; source: string } | undefined {
  const fromEnvironment = environment.AT_DASHBOARD_URL?.trim();
  if (fromEnvironment)
    return {
      url: dashboardBaseUrl(fromEnvironment, 'AT_DASHBOARD_URL'),
      source: 'AT_DASHBOARD_URL',
    };
  const file = workspaceFile(app);
  const value = file?.data.dashboard;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string')
    throw new Error(
      `${file!.path}: "dashboard" must be a URL string, e.g. "https://dashboard.example.com".`,
    );
  return { url: dashboardBaseUrl(value, `${file!.path} "dashboard"`), source: file!.path };
}

/**
 * Whether a run reports, and where: the dashboard URL when one is set; undefined for a local-only run (no URL, no
 * token, no product). A token or a product without a URL is a setup that meant to report, so it fails before any test
 * starts instead of quietly running without the dashboard.
 */
export function reportingTarget(
  app: string,
  environment: NodeJS.ProcessEnv = process.env,
): { url: string; source: string } | undefined {
  const dashboard = reportingDashboard(app, environment);
  if (dashboard) return dashboard;
  const file = workspaceFile(app);
  const reason = environment.AT_DASHBOARD_TOKEN?.trim()
    ? 'AT_DASHBOARD_TOKEN is set'
    : environment.AT_DASHBOARD_PRODUCT_KEY?.trim()
      ? 'AT_DASHBOARD_PRODUCT_KEY is set'
      : file && file.data.product !== undefined
        ? `${file.path} names a product`
        : '';
  if (!reason) return undefined;
  const where = file ? file.path : join(dirname(app), WORKSPACE_FILE);
  throw new Error(
    `No dashboard URL is set, but ${reason}. Add "dashboard": "<dashboard URL>" to ${where}, or set AT_DASHBOARD_URL. Tests were not started.`,
  );
}

export function reportingIdentity(appKey: string, app: string): Pick<Envelope, 'project' | 'app'> {
  const key = process.env.AT_DASHBOARD_APP_KEY || appKey;
  const product = reportingProduct(app).key;
  // The dashboard owns display names; these only label a brand-new application.
  return {
    project: { key: product, name: product },
    app: { key, name: process.env.AT_DASHBOARD_APP_NAME || key },
  };
}
