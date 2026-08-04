type XmlNode = XmlElementNode | XmlRawNode | XmlTextNode;

interface XmlElementNode {
  type: "element";
  name: string;
  open: string;
  close?: string;
  children: XmlNode[];
}

interface XmlRawNode {
  type: "raw";
  raw: string;
  preservesText?: boolean;
}

interface XmlTextNode {
  type: "text";
  text: string;
}

/**
 * Formats XML without using a DOM serializer. Attributes, comments, CDATA,
 * processing instructions, and DOCTYPE declarations remain byte-for-byte;
 * only structural whitespace is regenerated. Any element with direct text keeps
 * its source, including whitespace-only text nodes, so formatting cannot alter
 * text-node semantics.
 */
export function formatXmlSource(source: string, indent = "  "): string {
  const nodes = parseXmlDocument(source);
  return nodes
    .filter((node) => node.type !== "text" || node.text.trim())
    .map((node) => formatNode(node, 0, indent))
    .join("\n");
}

function parseXmlDocument(source: string): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlElementNode[] = [];
  let index = 0;
  const add = (node: XmlNode) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  while (index < source.length) {
    if (source[index] !== "<") {
      const end = source.indexOf("<", index);
      add({ type: "text", text: source.slice(index, end < 0 ? source.length : end) });
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) throw new SyntaxError("Unterminated XML comment");
      add({ type: "raw", raw: source.slice(index, end + 3) });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) throw new SyntaxError("Unterminated CDATA section");
      add({ type: "raw", raw: source.slice(index, end + 3), preservesText: true });
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0) throw new SyntaxError("Unterminated XML processing instruction");
      add({ type: "raw", raw: source.slice(index, end + 2) });
      index = end + 2;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(source.slice(index))) {
      const end = findMarkupEnd(source, index + 9);
      add({ type: "raw", raw: source.slice(index, end + 1) });
      index = end + 1;
      continue;
    }
    if (source.startsWith("</", index)) {
      const end = findMarkupEnd(source, index + 2);
      const raw = source.slice(index, end + 1);
      const match = raw.match(/^<\/\s*([A-Za-z_:][\w:.-]*)\s*>$/);
      if (!match) throw new SyntaxError("Invalid XML closing tag");
      const element = stack.pop();
      if (!element || element.name !== match[1]) throw new SyntaxError(`Unexpected XML closing tag: ${match[1]}`);
      element.close = raw;
      index = end + 1;
      continue;
    }
    if (source.startsWith("<!", index)) {
      const end = findMarkupEnd(source, index + 2);
      add({ type: "raw", raw: source.slice(index, end + 1) });
      index = end + 1;
      continue;
    }

    const end = findMarkupEnd(source, index + 1);
    const raw = source.slice(index, end + 1);
    const match = raw.match(/^<\s*([A-Za-z_:][\w:.-]*)(?=[\s/>])/);
    if (!match) throw new SyntaxError("Invalid XML opening tag");
    const element: XmlElementNode = { type: "element", name: match[1], open: raw, children: [] };
    add(element);
    if (!/\/\s*>$/.test(raw)) stack.push(element);
    index = end + 1;
  }

  if (stack.length) throw new SyntaxError(`Unclosed XML element: ${stack[stack.length - 1]?.name}`);
  const elements = roots.filter((node): node is XmlElementNode => node.type === "element");
  if (elements.length !== 1 || roots.some((node) => node.type === "text" && node.text.trim())) throw new SyntaxError("XML input must contain exactly one root element");
  return roots;
}

function findMarkupEnd(source: string, start: number): number {
  let quote: string | null = null;
  let subsetDepth = 0;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      subsetDepth++;
    } else if (character === "]") {
      subsetDepth--;
    } else if (character === ">" && subsetDepth === 0) {
      return index;
    }
  }
  throw new SyntaxError("Unterminated XML tag or declaration");
}

function formatNode(node: XmlNode, depth: number, indent: string): string {
  if (node.type === "text") return node.text;
  if (node.type === "raw") return node.raw;
  if (!node.close) return node.open;
  if (hasMeaningfulDirectText(node)) return originalNode(node);
  const children = node.children.filter((child) => child.type !== "text" || child.text.trim());
  if (!children.length) return `${node.open}${node.close}`;
  const childIndent = indent.repeat(depth + 1);
  return `${node.open}\n${children.map((child) => `${childIndent}${formatNode(child, depth + 1, indent)}`).join("\n")}\n${indent.repeat(depth)}${node.close}`;
}

function hasMeaningfulDirectText(element: XmlElementNode): boolean {
  return element.children.some((child) => child.type === "text" || (child.type === "raw" && child.preservesText));
}

function originalNode(node: XmlNode): string {
  if (node.type === "text") return node.text;
  if (node.type === "raw") return node.raw;
  return `${node.open}${node.children.map(originalNode).join("")}${node.close ?? ""}`;
}
