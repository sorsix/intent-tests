// The page text `expect` steps are judged on: the page's visible text in reading order, with its headings and named
// sections as Markdown-style "#" lines so the model can tell which section a line belongs to (snapshot.ts collectText
// collects the blocks in the browser). No imports, so the unit tests run without node_modules.

export type OutlineBlock = { heading: string; level: number } | { text: string };

/** Whitespace as the flat page text had it: runs of spaces collapsed, no blank lines. */
const clean = (s: string) =>
  s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

/** Blocks → text: "## Studies received" for a level-2 heading, text under it as shown. Cut to maxChars, markers included. */
export function formatOutline(blocks: OutlineBlock[], maxChars: number): string {
  const lines = blocks.map((b) =>
    'heading' in b
      ? `${'#'.repeat(Math.min(Math.max(Math.round(b.level), 1), 6))} ${b.heading.replace(/\s+/g, ' ').trim()}`
      : // Page text that itself looks like a heading line ("# 1 priority") must not read as one.
        clean(b.text).replace(/^(#+ )/gm, '\\$1'),
  );
  return clean(lines.join('\n')).slice(0, maxChars);
}
