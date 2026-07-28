import { describe, expect, it } from "vitest";
import { buildAiAgentPlan } from "../aiAgentPlan";
import { classifyAiSqlExecution } from "../aiSqlExecutionPolicy";
import type { ConnectionConfig } from "@/types/database";

const productionConnection: ConnectionConfig = {
  id: "conn-1",
  name: "Operations",
  db_type: "mysql",
  host: "db.internal",
  port: 3306,
  username: "readonly",
  password: "",
  production_databases: ["prod_app"],
};

describe("AI production SQL policy", () => {
  it("requires confirmation for a scoped production write", () => {
    expect(classifyAiSqlExecution("UPDATE users SET active = 1 WHERE id = 7", productionConnection, "prod_app")).toMatchObject({
      action: "confirm",
      environment: "production",
      reasons: ["production_write"],
    });
  });

  it("hands production write SQL back to the operator instead of auto-executing", () => {
    const plan = buildAiAgentPlan({
      mode: "agent",
      action: "generate",
      instruction: "execute the update",
      assistantContent: "```sql\nUPDATE users SET active = 1 WHERE id = 7\n```",
      connection: productionConnection,
      database: "prod_app",
    });

    expect(plan.executableSql).toBeUndefined();
    expect(plan.handoffSql).toContain("UPDATE users");
    expect(plan.steps).toContainEqual({ kind: "execute_sql", status: "skipped", reason: "requires_confirmation" });
  });
});
