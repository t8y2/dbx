import { qualifiedTableKey } from "./docsKeys";
import type { SchemaSnapshot } from "./types";

/**
 * Where the viewer is pointing.
 *
 * This exists so the standalone export can drive navigation from
 * `location.hash` without DocsApp itself touching the URL: DBX has no
 * router, and a viewer that wrote to the address bar would hijack the host
 * application's.
 */
export type DocsRoute = { kind: "index" } | { kind: "table"; key: string } | { kind: "enum"; name: string } | { kind: "diagram" };

const INDEX: DocsRoute = { kind: "index" };

/**
 * Resolve a hash against a snapshot.
 *
 * Anything unrecognised — junk, a table that no longer exists, the diagram
 * route on a host that did not enable it — resolves to the index. A saved
 * file whose schema has since changed is the expected case, not an exotic
 * one, and must never render blank.
 */
export function parseDocsHash(hash: string, snapshot: SchemaSnapshot, allowDiagram: boolean): DocsRoute {
  if (!hash.startsWith("#")) return INDEX;
  const segments = hash.slice(1).replace(/^\//, "").split("/");
  const [kind, ...rest] = segments;
  const identifier = rest.join("/");

  if (kind === "diagram" && identifier === "") return allowDiagram ? { kind: "diagram" } : INDEX;

  if (identifier === "") return INDEX;
  let decoded: string;
  try {
    decoded = decodeURIComponent(identifier);
  } catch {
    // A malformed percent-escape throws rather than returning null.
    return INDEX;
  }

  if (kind === "table") {
    return snapshot.tables.some((table) => qualifiedTableKey(table) === decoded) ? { kind: "table", key: decoded } : INDEX;
  }
  if (kind === "enum") {
    return (snapshot.enums ?? []).some((value) => value.name === decoded) ? { kind: "enum", name: decoded } : INDEX;
  }
  return INDEX;
}

export function formatDocsHash(route: DocsRoute): string {
  switch (route.kind) {
    case "table":
      return `#/table/${encodeURIComponent(route.key)}`;
    case "enum":
      return `#/enum/${encodeURIComponent(route.name)}`;
    case "diagram":
      return "#/diagram";
    default:
      return "#/";
  }
}
