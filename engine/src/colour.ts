// Colour names for `expect` steps that talk about colours ("expect the Monday tile to be green"). The page reports the
// computed background colour of its coloured areas (`pageColours` in snapshot.ts); this module turns those values into
// the plain names a test uses, in code, so the model compares words ("green") instead of judging RGB values or pixels.
// Pure and Node-free: unit-tested in test/colour.test.ts.

export type Rgba = { r: number; g: number; b: number; a: number };

/** The names `colourName` gives, and the words that make an `expect` step ask for the page's colours. */
export const COLOUR_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'grey',
  'white',
  'black',
] as const;

/**
 * Parses a CSS colour as `getComputedStyle` reports it: `rgb(r, g, b)`, `rgba(r, g, b, a)`, the space-separated
 * `rgb(r g b / a)`, `transparent` or `#rgb`/`#rrggbb`/`#rrggbbaa`. Anything else (gradients, `color(…)` spaces) is null.
 */
export function parseCssColour(css: string): Rgba | null {
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = s.match(/^rgba?\(\s*([^)]*)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const a =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? parseFloat(parts[3]) / 100
        : parseFloat(parts[3]);
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
}

/** `top` painted over the opaque colour `under` (source-over), as the browser shows a semi-transparent background. */
export function blend(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** `#rrggbb`, upper case, alpha ignored. */
export function toHex(c: Rgba): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/**
 * The plain name of an opaque colour: white, grey or black when it has little colour in it, otherwise the hue's name
 * (red, orange, yellow, green, teal, blue, purple, pink), with "light" or "dark" at either end of lightness.
 */
export function colourName(c: Rgba): string {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  if (chroma < 0.08 || saturation < 0.12) {
    if (lightness >= 0.93) return 'white';
    if (lightness <= 0.16) return 'black';
    return 'grey';
  }
  let hue =
    max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  const name =
    hue < 15 || hue >= 345
      ? 'red'
      : hue < 40
        ? 'orange'
        : hue < 65
          ? 'yellow'
          : hue < 165
            ? 'green'
            : hue < 195
              ? 'teal'
              : hue < 255
                ? 'blue'
                : hue < 290
                  ? 'purple'
                  : 'pink';
  if (lightness >= 0.8) return `light ${name}`;
  if (lightness <= 0.22) return `dark ${name}`;
  return name;
}

/** "green #358856": the name a test uses, then the exact value. */
export function describeColour(c: Rgba): string {
  return `${colourName(c)} ${toHex(c)}`;
}

const MENTION = new RegExp(
  `\\b(?:${[...COLOUR_NAMES, 'gray', 'colou?rs?', 'colou?red', 'background'].join('|')})\\b|#[0-9a-f]{3}(?:[0-9a-f]{3})?\\b`,
  'i',
);

/**
 * Whether a statement talks about colours: a colour name, "colour"/"color"/"background" or a `#hex` value, as a whole
 * word. A false match ("Green Clinic") only adds the colour list to that one question.
 */
export function mentionsColour(statement: string): boolean {
  return MENTION.test(statement);
}
