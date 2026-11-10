// Design tokens (#794): both palettes meet WCAG 2.x AA for the pairs the page
// actually draws, and the two copies of the dark palette (the prefers-color-scheme
// block and the explicit data-theme="dark" block) never drift apart.
import { describe, it, expect } from "vitest";
import { WEBMAIL_HTML } from "./src/webmail";

function block(marker: string, nth: number): Record<string, string> {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = WEBMAIL_HTML.indexOf(marker, at + 1);
    if (at < 0) throw new Error(`marker ${marker} #${nth} not found`);
  }
  const body = WEBMAIL_HTML.slice(at + marker.length, WEBMAIL_HTML.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum]. 4.5 = normal text, 3 = UI component / focus ring.
const PAIRS: Array<[string, string, number]> = [
  ["fg", "bg", 4.5], ["fg", "panel", 4.5], ["fg", "panel-2", 4.5],
  ["muted", "bg", 4.5], ["muted", "panel", 4.5], ["muted", "panel-2", 4.5],
  ["accent", "bg", 4.5], ["accent", "panel", 4.5], ["accent", "accent-dim", 4.5],
  ["accent-fg", "accent", 4.5], ["fg", "accent-dim", 4.5],
  ["bad", "panel", 4.5], ["bad", "bad-dim", 4.5], ["ok", "panel", 4.5], ["ok", "ok-dim", 4.5],
  ["frame-fg", "frame-bg", 4.5], ["frame-link", "frame-bg", 4.5],
  ["line-strong", "panel", 3], ["line-strong", "panel-2", 3], ["focus", "bg", 3], ["focus", "panel", 3], ["star", "panel", 3],
];

describe("webmail design tokens (#794)", () => {
  const light = block("/* tokens:light */", 0);
  const darkMedia = block("/* tokens:dark */", 0);
  const darkExplicit = block("/* tokens:dark */", 1);

  it("the contrast instrument can go red (positive control)", () => {
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("both dark blocks are the same palette", () => {
    expect(Object.keys(darkMedia).length).toBeGreaterThan(15);
    expect(darkExplicit).toEqual(darkMedia);
  });

  for (const [name, pal] of [["light", light], ["dark", darkMedia]] as const) {
    it(`${name} palette meets WCAG AA for every drawn pair`, () => {
      const fails: string[] = [];
      for (const [fg, bg, min] of PAIRS) {
        expect(pal[fg], `${name} --${fg}`).toBeDefined();
        expect(pal[bg], `${name} --${bg}`).toBeDefined();
        const r = contrast(pal[fg], pal[bg]);
        if (r < min) fails.push(`--${fg} on --${bg} = ${r.toFixed(2)} (< ${min})`);
      }
      expect(fails).toEqual([]);
    });
  }

  it("the light palette is the base and the dark one is opt-in or OS-driven", () => {
    expect(WEBMAIL_HTML).toContain("@media (prefers-color-scheme: dark)");
    expect(WEBMAIL_HTML).toContain(':root:not([data-theme="light"])');
    expect(WEBMAIL_HTML).toContain(':root[data-theme="dark"]');
    expect(WEBMAIL_HTML).toContain('<option value="system">');
  });

  it("the plain-text frame takes its colors through the color-grammar guard", () => {
    expect(WEBMAIL_HTML).toContain("function cssColor");
    expect(WEBMAIL_HTML).toContain('cs.getPropertyValue("--frame-bg")');
    // The hardcoded dark frame (#1c1f26) that ignored light mode is gone.
    expect(WEBMAIL_HTML).not.toContain("background:#1c1f26");
  });
});
