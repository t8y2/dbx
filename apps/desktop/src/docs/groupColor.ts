/**
 * Inline style exposing a table group's hue to CSS.
 *
 * A group stores ONE number. Lightness and chroma are fixed per theme in the
 * stylesheet — `--group-c: oklch(0.55 0.15 var(--h))` in light,
 * `oklch(0.76 0.13 var(--h))` in dark — so every hue is legible on both
 * grounds by construction. Computing a colour here would throw that away.
 */
export function groupStyle(hue: number | null): Record<string, string> {
  if (hue === null) {
    return {};
  }
  const wrapped = ((Math.trunc(hue) % 360) + 360) % 360;
  return { "--h": String(wrapped) };
}
