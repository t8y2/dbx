/** Shared low-level SVG string primitives for diagram-style exports. */

export function escapeXml(value: string | number): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function svgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function svgText(
  label: string,
  x: number,
  y: number,
  options: {
    size?: number;
    fill?: string;
    weight?: string;
    anchor?: "start" | "middle" | "end";
    family?: string;
    decoration?: string;
  } = {},
): string {
  const attrs = [`x="${svgNumber(x)}"`, `y="${svgNumber(y)}"`, `fill="${options.fill ?? "#18181b"}"`, `font-size="${options.size ?? 12}"`, `font-family="${options.family ?? "Arial, Helvetica, sans-serif"}"`, 'dominant-baseline="middle"'];
  if (options.weight) attrs.push(`font-weight="${options.weight}"`);
  if (options.anchor) attrs.push(`text-anchor="${options.anchor}"`);
  if (options.decoration) attrs.push(`text-decoration="${options.decoration}"`);
  return `<text ${attrs.join(" ")}>${escapeXml(label)}</text>`;
}
