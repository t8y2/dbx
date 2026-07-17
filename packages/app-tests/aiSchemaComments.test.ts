import assert from "node:assert/strict";
import { test } from "vitest";

import { buildSystemPrompt, type AiContext } from "../../apps/desktop/src/lib/ai/ai.ts";

const BASE_CONTEXT: AiContext = {
  connectionId: "conn-1",
  connectionName: "local",
  databaseType: "mysql",
  database: "app",
  currentSql: "",
  tables: [
    {
      name: "users",
      tableType: "BASE TABLE",
      comment: "用户表",
      columns: [
        {
          name: "id",
          data_type: "bigint",
          is_nullable: false,
          column_default: null,
          is_primary_key: true,
          extra: null,
          comment: "用户ID",
        },
        {
          name: "nickname",
          data_type: "varchar(64)",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
          comment: "用户昵称",
        },
      ],
    },
  ],
  sqlFiles: [],
  truncated: false,
};

test("AI schema context includes table and column comments", () => {
  const prompt = buildSystemPrompt("generate", BASE_CONTEXT);

  assert.match(prompt, /users \(BASE TABLE\)/);
  assert.match(prompt, /Comment: 用户表/);
  assert.match(prompt, /- id: bigint \(PK, NOT NULL\) -- 用户ID/);
  assert.match(prompt, /- nickname: varchar\(64\) \(nullable\) -- 用户昵称/);
});
