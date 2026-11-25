// Parameter sets turn one test into several. An app folder may contain a `parameters.ts` exporting
// `parameters: Record<string, ParameterSet>`; a test picks one with a `parameters: <name>` line, becomes one case per
// row, and reads the row as `{{param.<key>}}`. The rows are needed before anything runs (Playwright lists the cases,
// the dashboard catalog is published first), so a set is pure data: no network, clock, Playwright or top-level await.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  expandExamples,
  missingUploads,
  narrow,
  parseAll,
  ParseError,
  selectCases,
} from './parse.ts';
import type { ParameterRow, TestSuite } from './parse.ts';

export type ParameterValue = string | number | boolean;

/** `Row` may be an interface; its values must be strings, numbers or booleans, which is checked when the rows are read. */
export type ParameterSet<Row extends object = Record<string, ParameterValue>> = {
  description?: string;
  /** The rows, one case each. Called once per parse. */
  rows(): Row[];
  /**
   * The row's stable key, part of the case identity (`case:<id>[<key>]`), so keep it when reordering or adding rows.
   * Defaults to the row's values joined with "|".
   */
  key?(row: Row): string;
};

/** Every set's rows as strings with their keys, validated. */
export async function loadParameters(appRoot: string): Promise<Record<string, ParameterRow[]>> {
  const file = join(appRoot, 'parameters.ts');
  if (!existsSync(file)) return {};
  const mod = await import(pathToFileURL(file).href);
  const sets: Record<string, ParameterSet<object>> = mod.parameters ?? {};
  return Object.fromEntries(
    Object.entries(sets).map(([name, set]) => [name, resolveRows(name, set)]),
  );
}

export function resolveRows<Row extends object>(
  name: string,
  set: ParameterSet<Row>,
): ParameterRow[] {
  const where = `parameters.ts: set "${name}"`;
  const rows = set.rows();
  if (!Array.isArray(rows) || rows.length === 0) throw new ParseError(`${where} has no rows`);
  const keys = new Set<string>();
  return rows.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new ParseError(`${where}: row ${i + 1} is not an object`);
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!/^[A-Za-z0-9_]+$/.test(k))
        throw new ParseError(`${where}: row ${i + 1} key "${k}" must be letters, digits or _`);
      if (!['string', 'number', 'boolean'].includes(typeof v))
        throw new ParseError(
          `${where}: row ${i + 1} value "${k}" must be a string, number or boolean`,
        );
      values[k] = String(v);
    }
    const key = set.key ? set.key(row) : Object.values(values).join('|');
    if (typeof key !== 'string' || !key.trim() || key.length > 120 || /[\]\r\n]/.test(key)) {
      throw new ParseError(
        `${where}: row ${i + 1} key ${JSON.stringify(key)} must be 1-120 characters without "]" or line breaks`,
      );
    }
    if (keys.has(key))
      throw new ParseError(
        `${where}: two rows have the key "${key}"; give the set a key(row) that tells them apart`,
      );
    keys.add(key);
    return { key, values };
  });
}

/**
 * The app's cases as they run: parsed, templates expanded into one case per row, then narrowed to `only` and selected
 * by case id. `params` (AT_PARAMS) and `ids` (AT_CASE_IDS) default to the environment; '' turns them off.
 */
export async function loadSuite(
  appRoot: string,
  only: string | null,
  select: { params?: string; ids?: string } = {},
): Promise<TestSuite> {
  const suite = selectCases(
    narrow(expandExamples(parseAll(appRoot), await loadParameters(appRoot), select.params), only),
    select.ids,
  );
  const missing = missingUploads(suite, appRoot);
  if (missing.length) throw new ParseError(missing.join('\n'));
  return suite;
}
