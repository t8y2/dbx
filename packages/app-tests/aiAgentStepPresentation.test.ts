import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildAiAgentStepItems } from "../../apps/desktop/src/lib/aiAgentStepPresentation.ts";
import type { AiAgentPlan } from "../../apps/desktop/src/lib/aiAgentPlan.ts";

test("presents auto-execute agent plans as completed generation, safety, and execution steps", () => {
  const plan: AiAgentPlan = {
    executableSql: "SELECT count(*) FROM users",
    handoffSql: "SELECT count(*) FROM users",
    steps: [
      { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
      {
        kind: "risk_check",
        status: "done",
        action: "auto_execute",
        environment: "non_production",
        category: "read",
        reasons: [],
      },
      { kind: "execute_sql", status: "pending", sql: "SELECT count(*) FROM users" },
    ],
  };

  assert.deepEqual(buildAiAgentStepItems(plan), [
    { key: "generated", labelKey: "ai.agentSteps.generated", tone: "success" },
    {
      key: "safe",
      labelKey: "ai.agentSteps.safe",
      titleKey: "ai.agentStepTitles.riskCheck",
      titleParams: { action: "auto_execute", category: "read", environment: "non_production", reasons: "-" },
      tone: "success",
    },
    { key: "autoExecute", labelKey: "ai.agentSteps.autoExecute", tone: "active" },
  ]);
});

test("presents blocked and confirmation plans with warning tones", () => {
  const blocked: AiAgentPlan = {
    handoffSql: "DROP TABLE users",
    steps: [
      { kind: "generate_sql", status: "done", sql: "DROP TABLE users" },
      {
        kind: "risk_check",
        status: "done",
        action: "block",
        environment: "non_production",
        category: "dangerous",
        reasons: [],
      },
      { kind: "execute_sql", status: "skipped", reason: "blocked_by_policy" },
    ],
  };
  const confirm: AiAgentPlan = {
    handoffSql: "INSERT INTO users(name) VALUES ('a')",
    steps: [
      { kind: "generate_sql", status: "done", sql: "INSERT INTO users(name) VALUES ('a')" },
      {
        kind: "risk_check",
        status: "done",
        action: "confirm",
        environment: "production",
        category: "low_risk_write",
        reasons: [],
      },
      { kind: "execute_sql", status: "skipped", reason: "requires_confirmation" },
    ],
  };

  assert.deepEqual(
    buildAiAgentStepItems(blocked).map((item) => [item.labelKey, item.tone, item.titleKey, item.titleParams]),
    [
      ["ai.agentSteps.generated", "success", undefined, undefined],
      ["ai.agentSteps.blocked", "danger", "ai.agentStepTitles.riskCheck", { action: "block", category: "dangerous", environment: "non_production", reasons: "-" }],
      ["ai.agentSteps.skipped", "muted", "ai.agentStepTitles.blocked", undefined],
    ],
  );
  assert.deepEqual(
    buildAiAgentStepItems(confirm).map((item) => [item.labelKey, item.tone, item.titleKey, item.titleParams]),
    [
      ["ai.agentSteps.generated", "success", undefined, undefined],
      ["ai.agentSteps.needsConfirm", "warning", "ai.agentStepTitles.riskCheck", { action: "confirm", category: "low_risk_write", environment: "production", reasons: "-" }],
      ["ai.agentSteps.skipped", "muted", "ai.agentStepTitles.requiresConfirmation", undefined],
    ],
  );
});

test("includes risk reasons in risk check titles", () => {
  const plan: AiAgentPlan = {
    handoffSql: "INSERT INTO users(name) VALUES ('a'); UPDATE users SET name='b' WHERE id=1",
    steps: [
      {
        kind: "risk_check",
        status: "done",
        action: "confirm",
        environment: "non_production",
        category: "write",
        reasons: ["multi_statement"],
      },
    ],
  };

  assert.deepEqual(buildAiAgentStepItems(plan)[0], {
    key: "needsConfirm",
    labelKey: "ai.agentSteps.needsConfirm",
    titleKey: "ai.agentStepTitles.riskCheck",
    titleParams: {
      action: "confirm",
      category: "write",
      environment: "non_production",
      reasons: "multi_statement",
    },
    tone: "warning",
  });
});

test("presents no-sql and no-intent plans as muted skipped states", () => {
  const noSql: AiAgentPlan = {
    steps: [
      { kind: "generate_sql", status: "skipped", reason: "no_sql" },
      { kind: "execute_sql", status: "skipped", reason: "no_sql" },
    ],
  };
  const noIntent: AiAgentPlan = {
    steps: [
      { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
      { kind: "execute_sql", status: "skipped", reason: "no_execution_intent" },
    ],
  };

  assert.deepEqual(
    buildAiAgentStepItems(noSql).map((item) => item.labelKey),
    ["ai.agentSteps.noSql", "ai.agentSteps.skipped"],
  );
  assert.deepEqual(
    buildAiAgentStepItems(noIntent).map((item) => item.labelKey),
    ["ai.agentSteps.generated", "ai.agentSteps.notRequested"],
  );
});
