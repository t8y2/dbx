import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tauri = readFileSync(new URL("../tauri.ts", import.meta.url), "utf8");
const http = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const tauriRegistry = readFileSync(new URL("../../../../../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const webRegistry = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");
const coreOps = readFileSync(new URL("../../../../../../crates/dbx-core/src/document_ops.rs", import.meta.url), "utf8");

function functionBody(source: string, operation: string): string {
  const start = source.indexOf(`export async function ${operation}(`);
  expect(start, `${operation} transport function`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

/**
 * Nothing type-checks a frontend command name against its Rust registration, so
 * a rename on either side would ship a menu whose actions all fail at runtime.
 */
const operations = [
  { name: "elasticsearchGetIndexMetadata", command: "elasticsearch_get_index_metadata", route: "/api/document-store/elasticsearch/index-metadata" },
  { name: "elasticsearchDeleteAllDocuments", command: "elasticsearch_delete_all_documents", route: "/api/document-store/elasticsearch/documents/delete-all" },
] as const;

describe("Elasticsearch index action dual transport contract", () => {
  it.each(operations)("registers $name end-to-end", ({ name, command, route }) => {
    expect(functionBody(tauri, name).match(/invoke\("([^"]+)"/)?.[1], `${name} invoke command`).toBe(command);
    expect(functionBody(http, name).match(/post\("([^"]+)"/)?.[1], `${name} HTTP route`).toBe(route);
    expect(api).toContain(`${name} = forward("${name}")`);
    expect(tauriRegistry).toContain(`commands::document_cmd::${command},`);
    expect(webRegistry).toContain(`"${route.replace(/^\/api/, "")}",`);
  });

  it("sends the metadata kind literals the Rust enum deserializes", () => {
    const body = functionBody(tauri, "elasticsearchGetIndexMetadata");
    expect(body).toContain("kind,");
    // Mirrors ElasticsearchIndexMetadataKind's camelCase variant renaming.
    expect(tauri).toContain('export type ElasticsearchIndexMetadataKind = "mapping" | "settings" | "stats"');
    expect(coreOps).toContain("pub enum ElasticsearchIndexMetadataKind");
  });

  it("keeps the clear-index result fields the partial-clear check reads", () => {
    for (const field of ["total", "deleted", "versionConflicts", "timedOut", "failures"]) {
      expect(tauri, `ElasticsearchDeleteByQueryResult.${field}`).toContain(`  ${field}:`);
    }
  });

  it("guards the destructive clear behind a backend write check", () => {
    const commands = readFileSync(new URL("../../../../../../src-tauri/src/commands/document_cmd.rs", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../../../../../../crates/dbx-web/src/routes/document_store.rs", import.meta.url), "utf8");
    const tauriCommand = commands.slice(commands.indexOf("pub async fn elasticsearch_delete_all_documents("));
    const webRoute = routes.slice(routes.indexOf("pub async fn elasticsearch_delete_all_documents("));
    expect(tauriCommand.slice(0, tauriCommand.indexOf("\n}"))).toContain("ensure_connection_writable");
    expect(webRoute.slice(0, webRoute.indexOf("\n}"))).toContain("ensure_writable");
  });
});
