import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { UserSkillRootSettings, UserSkillsListResult } from "../../apps/desktop/src/types/userSkills";

const apiMock = vi.hoisted(() => ({
  listUserSkills: vi.fn(),
  readUserSkills: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

import { useUserSkillStore } from "../../apps/desktop/src/stores/userSkillStore.ts";

const rootSettings: UserSkillRootSettings = { customRootEnabled: true, customRoot: "D:/Team/dbx-skills" };

function listing(status: "ok" | "missing" | "invalid", skills: Array<{ id: string; name: string; description: string }>) {
  return { status, skills };
}

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.listUserSkills.mockReset();
  apiMock.readUserSkills.mockReset();
});

test("refresh groups custom root first and tracks statuses", async () => {
  apiMock.listUserSkills.mockResolvedValueOnce({
    defaultRoot: listing("ok", [
      { id: "d-2", name: "Zeta", description: "z" },
      { id: "d-1", name: "Alpha", description: "a" },
    ]),
    customRoot: listing("ok", [{ id: "c-1", name: "Team Rules", description: "t" }]),
  } satisfies UserSkillsListResult);

  const store = useUserSkillStore();
  assert.equal(await store.refresh(rootSettings), true);
  assert.deepEqual(
    store.groupedSkills.map((group) => group.source),
    ["custom", "default"],
  );
  assert.equal(store.totalCount, 3);
  assert.equal(store.metaFor("c-1")?.name, "Team Rules");
  assert.equal(store.defaultRootStatus, "ok");
  assert.equal(store.customRootStatus, "ok");
  assert.equal(apiMock.listUserSkills.mock.calls[0][0], rootSettings);
});

test("absent default root and disabled custom root yield empty groups, not errors", async () => {
  apiMock.listUserSkills.mockResolvedValueOnce({
    defaultRoot: listing("missing", []),
    customRoot: null,
  } satisfies UserSkillsListResult);

  const store = useUserSkillStore();
  assert.equal(await store.refresh({ customRootEnabled: false, customRoot: null }), true);
  assert.equal(store.totalCount, 0);
  assert.deepEqual(store.groupedSkills, []);
  assert.equal(store.lastError, null);
  assert.equal(store.hasLoadedOnce, true);
});

test("refresh failure keeps prior catalog and records retryable error", async () => {
  apiMock.listUserSkills.mockResolvedValueOnce({
    defaultRoot: listing("ok", [{ id: "d-1", name: "Alpha", description: "a" }]),
    customRoot: null,
  } satisfies UserSkillsListResult);
  const store = useUserSkillStore();
  await store.refresh(rootSettings);

  apiMock.listUserSkills.mockRejectedValueOnce(new Error("backend unavailable"));
  assert.equal(await store.refresh(rootSettings), false);
  assert.equal(store.lastError, "backend unavailable");
  // Prior catalog remains so chips keep their display metadata.
  assert.equal(store.totalCount, 1);
  assert.equal(store.metaFor("d-1")?.name, "Alpha");
});
