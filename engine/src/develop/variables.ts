// The values a develop session shows for `{{seed.<key>}}`, `{{saved.<name>}}` and `{{param.<key>}}` (docs/develop-mode.md,
// section 3.6): the seed's result, what `call … and save` steps saved, and the template row. Environment variables are
// the secrets channel and never come here. Pure; tested in test/develop-variables.test.ts.
import type { RecordedStep, SessionVariables } from './protocol.ts';

/** Keys whose values are never shown, at any depth of a non-string value. */
export const SECRET_KEY = /pass|secret|token|key/i;
export const MASKED = '••••';
export const MAX_VALUE_CHARS = 200;

/** A value as text: strings as they are, anything else as JSON with secret-looking keys masked inside it. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, (key, item: unknown) =>
      key && SECRET_KEY.test(key) ? MASKED : typeof item === 'bigint' ? String(item) : item,
    );
    if (json !== undefined) return json;
  } catch {
    // A cycle: fall back to the plain conversion.
  }
  return String(value);
}

/** What the session shows for one value: masked when its key looks secret, else text cut to 200 characters. */
export function shownValue(key: string, value: unknown): string {
  if (SECRET_KEY.test(key)) return MASKED;
  const text = asText(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

function shown(values: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) out[key] = shownValue(key, value);
  return out;
}

/** The `SessionVariables` for the seed's vars, the runner's saved values and the template row. */
export function sessionVariables(sources: {
  seed?: Readonly<Record<string, unknown>>;
  saved?: Readonly<Record<string, unknown>>;
  param?: Readonly<Record<string, unknown>>;
}): SessionVariables {
  return { seed: shown(sources.seed), saved: shown(sources.saved), param: shown(sources.param) };
}

/**
 * A recorded step written with the session's values as variables: a quoted label, row or value that is exactly a
 * `{{seed.*}}`, `{{saved.*}}` or `{{param.*}}` value becomes that variable (the seed makes new data every run, so the
 * literal would not be found next time), and an `open` of a value's address becomes `open "{{seed.link}}"`. A value
 * shorter than 3 characters is only used for the step's own value (the option chosen, the text filled in) and only
 * when one variable has it; masked and cut values are never used.
 */
export function withVariables(
  text: string,
  kind: RecordedStep['kind'],
  variables: SessionVariables,
): string {
  const entries: [string, string][] = [];
  for (const space of ['seed', 'saved', 'param'] as const)
    for (const [key, value] of Object.entries(variables[space]))
      if (value.trim() && value !== MASKED && !value.endsWith('…') && !/["\n]|\{\{/.test(value))
        entries.push([`{{${space}.${key}}}`, value]);
  if (!entries.length) return text;
  const lookup = (quoted: string, isValue: boolean) => {
    const hits = entries.filter(([, value]) => value === quoted);
    if (!hits.length || (quoted.length < 3 && (!isValue || hits.length > 1))) return undefined;
    return hits[0][0];
  };
  if (kind === 'open') {
    const path = /^open "(.*)"$/.exec(text)?.[1];
    if (path === undefined) return text;
    for (const [name, value] of entries) {
      if (value === path) return `open "${name}"`;
      try {
        const url: URL = new URL(value);
        if (/^https?:$/.test(url.protocol) && url.pathname + url.search + url.hash === path)
          return `open "${name}"`;
      } catch {
        // not an address
      }
    }
    return text;
  }
  if (kind === 'press') return text;
  // A fill's value is the last quoted thing and may hold quotes; the target's quotes never do.
  let target = text;
  let value: string | undefined;
  if (kind === 'fill') {
    const m = /^(fill .*?) with "(.*)"$/s.exec(text);
    if (!m) return text;
    [, target, value] = m;
  }
  let first = true;
  target = target.replace(/"([^"]*)"/g, (all, quoted: string) => {
    const isValue = kind === 'select' && first;
    first = false;
    const name = lookup(quoted, isValue);
    return name ? `"${name}"` : all;
  });
  if (value === undefined) return target;
  return `${target} with "${lookup(value, true) ?? value}"`;
}
