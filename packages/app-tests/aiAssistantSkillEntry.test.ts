import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// AiAssistant.vue has no mounted-DOM harness in this repo (no @vue/test-utils),
// so this pins the /skill contract on the compiled SFC source, the same way
// aiAssistantComposerLayout.test.ts pins the composer layout.
const source = readFileSync(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("/skill rides its own command source instead of the action lists", () => {
  const commands = section("const filteredCommands = computed", "const AI_SQL_FILE_MENTION_CANDIDATE_LIMIT");
  assert.ok(commands.includes('{ type: "skills" }'), "filteredCommands must merge a dedicated skills entry");
  assert.ok(commands.includes('type: "action"'), "action entries must stay in the same command list");

  // The built-in action arrays must not gain a skill entry: they also feed the
  // mode+action picker, which would then offer /skill as a selectable action.
  for (const marker of ["/** Ask-mode actions: SQL-producing, never auto-run. */", "/** Agent-mode actions: task-oriented, drive tool use and real results. */"]) {
    const list = section(marker, "];");
    assert.ok(!/skill/i.test(list.replace(/AiActionButton/g, "")), `action list must not contain a skill entry: ${marker}`);
  }
});

test("selecting /skill never changes the built-in action", () => {
  const body = section("function selectCommand(command: AiSlashEntry)", "\nfunction insertMention");
  const skillsBranch = body.indexOf('command.type === "skills"');
  const actionAssign = body.indexOf("activeAction.value = command.button.action");
  assert.notEqual(skillsBranch, -1, "selectCommand must branch on the skills entry");
  assert.notEqual(actionAssign, -1, "selectCommand must still assign the chosen action");
  assert.ok(skillsBranch < actionAssign, "the skills branch must be evaluated before any action assignment");

  const branch = body.slice(skillsBranch, actionAssign);
  assert.ok(branch.includes("showSkillSelector.value = true"), "the skills branch must open the selector");
  assert.ok(branch.includes("return"), "the skills branch must return before the action assignment");
  assert.ok(!branch.includes("activeAction"), "the skills branch must not touch activeAction");
});

test("the skills selector only ever lists metadata", () => {
  const selector = section('<Popover v-model:open="showSkillSelector">', 'v-if="mentionOpen"');
  assert.ok(selector.length > 0);
  assert.ok(selector.includes("userSkillStore.groupedSkills"), "the selector renders the metadata catalog");
  assert.ok(!selector.includes("readUserSkills"), "the selector must never read skill bodies");
  assert.ok(selector.includes("refreshSkills"), "the selector exposes Refresh");
});
