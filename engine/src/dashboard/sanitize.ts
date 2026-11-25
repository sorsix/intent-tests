// Environment names whose values are secrets. Values of at least three characters are redacted, as before.
const SECRET_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
// Any other `…_KEY` (MICROSOFT_FOUNDRY_KEY) is treated as a secret only when its value is long enough to be one, so
// short identifiers such as an app key are never redacted out of captured evidence.
const KEY_NAME = /(^|_)KEY$/i;
const KEY_MIN_LENGTH = 8;
// `*_KEY` variables the engine reads that are catalog identifiers, not credentials.
const NOT_SECRET = new Set(['AT_DASHBOARD_PRODUCT_KEY', 'AT_DASHBOARD_APP_KEY']);

export function isSecretVariable(name: string, value: string | undefined): boolean {
  if (!value || NOT_SECRET.has(name.toUpperCase())) return false;
  if (SECRET_NAME.test(name)) return value.length >= 3;
  return KEY_NAME.test(name) && value.length >= KEY_MIN_LENGTH;
}

let memo: { size: number; secrets: string[] } | null = null;
// Rebuilt when variables are added or removed (env files load into process.env); tests that change a value in
// place call resetSecretCache.
function secretValues(): string[] {
  const size = Object.keys(process.env).length;
  if (memo?.size !== size) {
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => isSecretVariable(key, value))
      .map(([, value]) => value!)
      .sort((a, b) => b.length - a.length);
    memo = { size, secrets: [...new Set(secrets)] };
  }
  return memo.secrets;
}
export function resetSecretCache(): void {
  memo = null;
}

// Dashboard capture never serializes the environment; redact known secrets within captured evidence.
export function sanitize<T>(value: T): T {
  const secrets = secretValues();
  const visit = (item: unknown, key = ''): unknown => {
    if (
      /^(password|passwd|secret|apiKey|authorization|cookie|set-cookie)$/i.test(key) &&
      item != null
    )
      return '[REDACTED]';
    if (typeof item === 'string')
      return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item);
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([name, child]) => [name, visit(child, name)]),
      );
    return item;
  };
  return visit(value) as T;
}

/** Explicit reporting lineage identifies records; redact evidence without rewriting those keys. */
export function captureRecord(record: Record<string, unknown>): Record<string, unknown> {
  const captured = sanitize(record);
  for (const key of ['clientDecisionId', 'type'])
    if (Object.hasOwn(record, key)) captured[key] = record[key];
  const ctx = record.ctx;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    const original = ctx as Record<string, unknown>;
    const context = captured.ctx as Record<string, unknown>;
    for (const key of ['clientTestId', 'attempt', 'clientStepId', 'pass'])
      if (Object.hasOwn(original, key)) context[key] = original[key];
  }
  const failure = record.failure;
  if (failure && typeof failure === 'object' && !Array.isArray(failure)) {
    const original = failure as Record<string, unknown>;
    const diagnosed = captured.failure as Record<string, unknown>;
    for (const key of ['kind', 'origin'])
      if (Object.hasOwn(original, key)) diagnosed[key] = original[key];
  }
  const answer = record.answer;
  if (
    answer &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    Object.hasOwn(answer, 'type')
  ) {
    (captured.answer as Record<string, unknown>).type = (answer as Record<string, unknown>).type;
  }
  if (JSON.stringify(captured) !== JSON.stringify(record))
    captured.reportingRedactions = {
      applied: true,
      policy: 'known-secret-values-and-sensitive-keys',
    };
  return captured;
}
