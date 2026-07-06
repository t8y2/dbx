import { strict as assert } from "node:assert";
import { test } from "vitest";
import type { AiAction } from "../../apps/desktop/src/lib/ai/ai.ts";
import { AI_SKILL_DEFINITIONS, aiSkillForAction } from "../../apps/desktop/src/lib/ai/aiSkills.ts";

const actions: AiAction[] = [
  "generate",
  "explain",
  "optimize",
  "fix",
  "convert",
  "sampleData",
  "query",
  "exploreSchema",
  "executeAndExplain",
];

test("defines one internal AI skill per assistant action", () => {
  assert.deepEqual(AI_SKILL_DEFINITIONS.map((skill) => skill.action).sort(), [...actions].sort());

  for (const action of actions) {
    const skill = aiSkillForAction(action);

    assert.equal(skill.action, action);
    assert.match(skill.id, /^[a-z][a-z0-9_]*$/);
    assert.ok(skill.title.zh);
    assert.ok(skill.title.en);
    assert.ok(skill.contextNeeds.length > 0);
    assert.ok(skill.systemRules.zh.length > 0);
    assert.ok(skill.systemRules.en.length > 0);
    assert.ok(skill.userInstruction.zh.length > 0);
    assert.ok(skill.userInstruction.en.length > 0);
  }
});

test("captures safety and output contracts for agent-ready skills", () => {
  const generate = aiSkillForAction("generate");
  assert.equal(generate.riskPolicy, "readonly_preferred");
  assert.match(generate.outputContract.zh.join("\n"), /第一个 ```sql 代码块/);
  assert.match(generate.systemRules.zh.join("\n"), /外键关系/);

  const optimize = aiSkillForAction("optimize");
  assert.equal(optimize.riskPolicy, "readonly");
  assert.deepEqual(optimize.contextNeeds, ["currentSql", "schema", "indexes", "foreignKeys"]);
  assert.match(optimize.systemRules.zh.join("\n"), /索引信息/);
  assert.match(optimize.outputContract.zh.join("\n"), /最多 3 条说明/);

  const fix = aiSkillForAction("fix");
  assert.ok(fix.contextNeeds.includes("lastError"));
  assert.match(fix.outputContract.zh.join("\n"), /错误原因/);
});
