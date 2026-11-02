import type { DatabaseModelShape } from "./modelShape";
import { pascalCase } from "./modelShape";

export interface ModelTemplate {
  id: string;
  name: string;
  extension: string;
  body: string;
}
export function normalizeModelTemplates(value: unknown): ModelTemplate[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value
    .filter((item): item is ModelTemplate => {
      if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || typeof item.body !== "string" || typeof item.extension !== "string" || !/^[a-zA-Z0-9]+$/.test(item.extension)) return false;
      ids.add(item.id);
      return true;
    })
    .map(({ id, name, extension, body }) => ({ id, name, extension, body }));
}

/** A data-only template interpreter: substitution, column iteration and boolean sections. */
export function renderModelTemplate(template: string, shape: DatabaseModelShape): string {
  type Context = Record<string, unknown>;
  const base: Context = { "table.name": shape.tableName, "table.schema": shape.schema ?? "", "table.comment": shape.tableComment ?? "", "class.name": pascalCase(shape.tableName) };
  const tokens = template.split(/({{[\s\S]*?}})/g);
  type Node = string | { key: string; children?: Node[] };
  let position = 0;
  function parse(end?: string): Node[] {
    const nodes: Node[] = [];
    while (position < tokens.length) {
      const token = tokens[position++]!;
      if (!token.startsWith("{{")) {
        nodes.push(token);
        continue;
      }
      const key = token.slice(2, -2).trim();
      if (key.startsWith("/")) {
        if (key.slice(1) !== end) throw new Error(`Unexpected template section: ${key}`);
        return nodes;
      }
      if (key.startsWith("#")) nodes.push({ key: key.slice(1), children: parse(key.slice(1)) });
      else nodes.push({ key });
    }
    if (end) throw new Error(`Unclosed template section: ${end}`);
    return nodes;
  }
  function render(nodes: Node[], context: Context): string {
    return nodes
      .map((node) => {
        if (typeof node === "string") return node;
        if (node.children && node.key === "columns")
          return shape.columns
            .map((column) =>
              render(node.children!, {
                ...context,
                "column.name": column.name,
                "column.type": column.normalizedType,
                "column.originalType": column.originalType,
                "column.nullable": column.nullable,
                "column.primaryKey": column.primaryKey,
                "column.defaultValue": column.defaultValue ?? "",
                "column.comment": column.comment ?? "",
              }),
            )
            .join("");
        if (!Object.prototype.hasOwnProperty.call(context, node.key)) throw new Error(`Unknown template variable: ${node.key}`);
        return node.children ? (context[node.key] ? render(node.children, context) : "") : String(context[node.key]);
      })
      .join("");
  }
  return render(parse(), base);
}
