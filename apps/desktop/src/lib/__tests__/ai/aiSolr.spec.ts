import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAiContext, buildSystemPrompt, type AiContext } from "@/lib/ai/ai";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const apiMock = vi.hoisted(() => ({
  listTables: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

function solrConnection(): ConnectionConfig {
  return {
    id: "solr-1",
    name: "Solr",
    db_type: "solr",
    host: "127.0.0.1",
    port: 8983,
    username: "",
    password: "",
  };
}

function queryTab(): QueryTab {
  return {
    id: "tab-1",
    title: "Query",
    connectionId: "solr-1",
    database: "default",
    sql: "GET /products/select?q=*:*",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
  };
}

function solrAiContext(): AiContext {
  return {
    connectionId: "solr-1",
    connectionName: "Solr",
    databaseType: "solr",
    database: "default",
    currentSql: "GET /products/select?q=*:*",
    tables: [
      {
        name: "products",
        tableType: "CORE",
        columns: [
          { name: "id", data_type: "string", is_primary_key: true, is_nullable: false, column_default: null, extra: null },
          { name: "title", data_type: "text_general", is_primary_key: false, is_nullable: true, column_default: null, extra: null },
        ],
      },
    ],
    sqlFiles: [],
    csvFiles: [],
    schemaScope: "database",
    truncated: false,
  };
}

describe("Solr AI context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listTables.mockResolvedValue([{ name: "products", table_type: "CORE" }]);
    apiMock.getColumns.mockResolvedValue([]);
    apiMock.listIndexes.mockResolvedValue([]);
    apiMock.listForeignKeys.mockResolvedValue([]);
  });

  it("loads Solr cores as schema tables through the generic metadata path", async () => {
    const context = await buildAiContext(queryTab(), solrConnection());

    expect(context.databaseType).toBe("solr");
    expect(apiMock.listTables).toHaveBeenCalledWith("solr-1", "default", "default");
    expect(apiMock.getColumns).toHaveBeenCalledWith("solr-1", "default", "default", "products");
    expect(context.tables.map((table) => table.name)).toEqual(["products"]);
  });
});

describe("Solr AI system prompt", () => {
  it("describes the REST-console request format instead of SQL", () => {
    const prompt = buildSystemPrompt("generate", solrAiContext(), "ask");

    expect(prompt).toContain("Apache Solr");
    expect(prompt).toContain("METHOD /path");
    expect(prompt).toContain("Solr");
    // The prompt must not instruct the model to emit SQL for Solr.
    expect(prompt).not.toContain("adapt SQL to the active database dialect");
    expect(prompt).not.toContain("Generate SQL and explanations only");
  });

  it("frames agent-mode tools with core semantics", () => {
    const prompt = buildSystemPrompt("query", solrAiContext(), "agent");

    expect(prompt).toContain("list_tables");
    expect(prompt).toContain("execute_query");
    expect(prompt).toContain("METHOD /path");
    expect(prompt).toContain("core");
  });
});
