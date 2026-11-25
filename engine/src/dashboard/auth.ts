// Tokens remain in memory and HTTP headers; never include them in a reporting spool.
import type { EnginePolicy } from './engine-version.ts';
type Environment = Record<string, string | undefined>;

/**
 * A dashboard base URL as given in AT_DASHBOARD_URL or intent-workspace.json `dashboard`: http(s) only, without a
 * trailing slash. `source` names where it came from, for the error.
 */
export function dashboardBaseUrl(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${source}: "${value}" is not a URL, e.g. "https://dashboard.example.com".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${source}: the dashboard URL must start with https:// or http://.`);
  if (url.search || url.hash || url.username || url.password)
    throw new Error(
      `${source}: the dashboard URL must not carry a query, fragment or credentials.`,
    );
  return (url.origin + url.pathname).replace(/\/+$/, '');
}
export class DashboardAuth {
  async token(environment: Environment = process.env): Promise<string | undefined> {
    return environment.AT_DASHBOARD_TOKEN?.trim() || undefined;
  }
}
export function requiredReportingToken(
  environment: Environment = process.env,
  dashboard?: string,
): {
  token: string;
  kind: 'personal' | 'automation';
} {
  const token = environment.AT_DASHBOARD_TOKEN?.trim() || '';
  const ci = !!environment.CI && !['false', '0'].includes(environment.CI.toLowerCase());
  const kind = ci ? 'automation' : 'personal';
  const prefix = ci ? 'auto' : 'pat';
  if (!new RegExp(`^pit_${prefix}_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$`).test(token)) {
    throw new Error(
      `${ci ? 'CI runs require an automation token' : 'Local runs require a personal access token'}. Create one${dashboard ? ` at ${dashboard}/settings?tab=${ci ? 'automation' : 'users'}` : ' in the dashboard'} and set AT_DASHBOARD_TOKEN.`,
    );
  }
  return { token, kind };
}
// Returns the dashboard's engine version policy; an older dashboard returns none. With a product, also checks that the
// dashboard knows it, since reports never create products.
export async function authorizeRunner(
  dashboard: string,
  environment: Environment = process.env,
  request: typeof fetch = fetch,
  product?: string,
): Promise<EnginePolicy | undefined> {
  const { token, kind } = requiredReportingToken(environment, dashboard);
  const response = await request(`${dashboard}/api/runner/access`, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Dashboard access rejected (HTTP ${response.status}). Check the token's expiry, revocation and reporting permissions. Tests were not started.`,
    );
  const user = (await response.json()) as {
    credentialKind?: string;
    permissions?: string[];
    engine?: EnginePolicy;
  };
  if (user.credentialKind !== kind || !user.permissions?.includes('reports.write'))
    throw new Error(
      'The dashboard token does not grant the required test reporting access. Tests were not started.',
    );
  if (product) await requireProduct(dashboard, product, token, request);
  return user.engine && typeof user.engine === 'object' ? user.engine : undefined;
}

async function requireProduct(
  dashboard: string,
  product: string,
  token: string,
  request: typeof fetch,
) {
  const response = await request(`${dashboard}/api/projects`, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Could not read the dashboard's products (HTTP ${response.status}). Tests were not started.`,
    );
  const products = (await response.json()) as { key?: string }[];
  if (!products.some((item) => item.key === product))
    throw new Error(
      `Product "${product}" is not registered on the dashboard. Create it in Products & apps (${dashboard}/products), or correct "product" in intent-workspace.json. Tests were not started.`,
    );
}
