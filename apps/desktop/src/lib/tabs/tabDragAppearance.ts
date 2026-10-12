/** 只传递标签的展示快照，不传 QueryTab、DOM、事件处理器或编辑器状态。 */
export interface TabDragVisual {
  style: Record<string, string>;
  text?: string;
  image?: string;
  children?: TabDragVisual[];
}

export interface TabDragAppearance {
  width: number;
  height: number;
  grabX: number;
  grabY: number;
  pixelRatio: number;
  style: Record<string, string>;
  parts: TabDragVisual[];
}

const paintProperties = [
  "color",
  "background-color",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "box-shadow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "opacity",
  "object-fit",
];
const svgTags = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "text", "tspan"]);
const svgAttributes = new Set(["viewBox", "d", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "transform", "id", "offset", "gradientUnits", "gradientTransform", "clipPathUnits", "maskUnits"]);
const svgPaint = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "color", "stop-color", "stop-opacity", "clip-path"];

function paint(element: Element, pseudo?: string): Record<string, string> {
  const computed = getComputedStyle(element, pseudo);
  return Object.fromEntries(paintProperties.map((name) => [name, computed.getPropertyValue(name)]).filter(([, value]) => value));
}

/** SVG 仅保留图形白名单和已解析的颜色，不复制脚本、外链、HTML 或监听器。 */
function svgImage(element: Element): string {
  function copy(node: Element): Element | null {
    if (!svgTags.has(node.localName)) return null;
    const target = document.createElementNS("http://www.w3.org/2000/svg", node.localName);
    for (const attribute of Array.from(node.attributes)) {
      if (svgAttributes.has(attribute.name)) target.setAttribute(attribute.name, attribute.value);
    }
    const computed = getComputedStyle(node);
    for (const name of svgPaint) {
      let value = computed.getPropertyValue(name) || node.getAttribute(name);
      if (!value) continue;
      value = value.replace(/url\(["']?[^)#]*#([^)'"\s]+)["']?\)/g, "url(#$1)");
      if (/url\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) continue;
      target.setAttribute(name, value);
    }
    if (node.localName === "text" || node.localName === "tspan") target.textContent = node.textContent;
    else
      for (const child of Array.from(node.children)) {
        const copied = copy(child);
        if (copied) target.appendChild(copied);
      }
    return target;
  }
  const svg = copy(element)!;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

export function isTabDragImage(value: string): boolean {
  return /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]|blob:|https?:\/\/|asset:\/\/)/i.test(value);
}

function imageSource(image: HTMLImageElement): string | undefined {
  // 将已加载的本地/插件图片变成小图，避免源窗口 Blob 被撤销后预览丢图。
  if (image.complete && image.naturalWidth > 0) {
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      }
    } catch {
      /* 跨源图片不能读取像素时，保留已经在源标签使用的图片地址。 */
    }
  }
  const source = image.currentSrc || image.src;
  return isTabDragImage(source) ? source : undefined;
}

function visual(element: Element, origin: DOMRect, borderX = 0, borderY = 0): TabDragVisual | null {
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  if (!rect.width || !rect.height || computed.display === "none" || computed.visibility === "hidden") return null;
  const style = {
    ...paint(element),
    position: "absolute",
    "box-sizing": "border-box",
    margin: "0",
    left: `${rect.left - origin.left - borderX}px`,
    top: `${rect.top - origin.top - borderY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    "white-space": "nowrap",
    overflow: "hidden",
    "text-overflow": "ellipsis",
  };
  if (element.localName === "svg") return { style, image: svgImage(element) };
  if (element instanceof HTMLImageElement) return { style, image: imageSource(element) };
  const children = Array.from(element.children)
    .map((child) => visual(child, rect, parseFloat(computed.borderLeftWidth) || 0, parseFloat(computed.borderTopWidth) || 0))
    .filter((child): child is TabDragVisual => !!child);
  return { style, ...(children.length ? { children } : { text: element.textContent ?? "" }) };
}

export function captureTabDragAppearance(source: HTMLElement, point: { x: number; y: number }): TabDragAppearance {
  const rect = source.getBoundingClientRect();
  const computed = getComputedStyle(source);
  const borderX = parseFloat(computed.borderLeftWidth) || 0;
  const borderY = parseFloat(computed.borderTopWidth) || 0;
  const parts = Array.from(source.querySelectorAll<HTMLElement>("[data-tab-label-part], [data-tab-execution-status]")).flatMap((part) => {
    // readonly 插槽使用 display:contents，不额外改变原标签的 flex 布局。
    const elements = getComputedStyle(part).display === "contents" ? Array.from(part.querySelectorAll("button")) : [part];
    return elements.map((element) => visual(element, rect, borderX, borderY)).filter((item): item is TabDragVisual => !!item);
  });
  for (const pseudo of ["::before", "::after"]) {
    const style = getComputedStyle(source, pseudo);
    if (style.content !== '""' || style.display === "none" || style.position !== "absolute") continue;
    const decoration = paint(source, pseudo);
    for (const name of ["position", "left", "top", "right", "bottom", "width", "height", "transform", "z-index"]) decoration[name] = style.getPropertyValue(name);
    parts.push({ style: decoration });
  }
  const style = paint(source);
  // 标签原本可能透明，浮到桌面后仍需保留它在标签栏上看到的底色。
  const backgrounds: string[] = [];
  for (let element: HTMLElement | null = source; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") continue;
    if (color.startsWith("rgb(") || (color.startsWith("oklch(") && !color.includes("/"))) {
      style["background-color"] = color;
      break;
    }
    backgrounds.push(`linear-gradient(${color}, ${color})`);
  }
  if (backgrounds.length) style["background-image"] = backgrounds.join(", ");
  return {
    width: rect.width,
    height: rect.height,
    grabX: Math.max(0, Math.min(rect.width, point.x - rect.left)),
    grabY: Math.max(0, Math.min(rect.height, point.y - rect.top)),
    pixelRatio: window.devicePixelRatio || 1,
    style,
    parts,
  };
}
