import { describe, expect, it } from "vitest";
import { buildAiConversationSearchIndex, filterAiConversationSearchIndex } from "@/lib/ai/aiConversationSearch";

const conversations = [
  {
    id: "mysql-users",
    title: "Repair user records",
    connectionName: "dev-mysql",
    database: "accounts",
    messages: [
      { role: "user", content: "How can I find duplicate email addresses?" },
      { role: "assistant", content: "Use a GROUP BY query with HAVING COUNT(*) > 1." },
    ],
  },
  {
    id: "postgres-orders",
    title: "订单排查",
    connectionName: "prod-postgres",
    database: "commerce",
    messages: [{ role: "user", content: "查询昨天失败的订单" }],
  },
];

describe("AI conversation search index", () => {
  const index = buildAiConversationSearchIndex(conversations);

  it("finds history by title, connection, database, or message text without case sensitivity", () => {
    expect(filterAiConversationSearchIndex(index, "  REPAIR  ").map((conversation) => conversation.id)).toEqual(["mysql-users"]);
    expect(filterAiConversationSearchIndex(index, "POSTGRES").map((conversation) => conversation.id)).toEqual(["postgres-orders"]);
    expect(filterAiConversationSearchIndex(index, "ACCOUNTS").map((conversation) => conversation.id)).toEqual(["mysql-users"]);
    expect(filterAiConversationSearchIndex(index, "duplicate EMAIL").map((conversation) => conversation.id)).toEqual(["mysql-users"]);
    expect(filterAiConversationSearchIndex(index, "失败的订单").map((conversation) => conversation.id)).toEqual(["postgres-orders"]);
  });

  it("restores the complete history when the search is cleared", () => {
    expect(filterAiConversationSearchIndex(index, "   ")).toEqual(conversations);
  });

  it("returns an empty history when no conversation matches", () => {
    expect(filterAiConversationSearchIndex(index, "oracle")).toEqual([]);
  });

  it("precomputes normalized searchable text once per conversation", () => {
    expect(index.map((entry) => entry.searchText)).toEqual(["repair user records\ndev-mysql\naccounts\nhow can i find duplicate email addresses?\nuse a group by query with having count(*) > 1.", "订单排查\nprod-postgres\ncommerce\n查询昨天失败的订单"]);
  });
});
