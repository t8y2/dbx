import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarLayout } from "@/types/database";

const PROTECTION_HASH = "pbkdf2-sha256$600000$c2FsdA==$aGFzaA==";

function layoutWithGroup(options: { passwordHash?: string } = {}): SidebarLayout {
  return {
    groups: [{ id: "project", name: "Project", collapsed: false, ...(options.passwordHash ? { passwordHash: options.passwordHash } : {}) }],
    order: [
      {
        type: "group",
        id: "project",
        children: [{ type: "connection", id: "grouped" }],
      },
      { type: "connection", id: "root" },
    ],
  };
}

describe("connectionGroupPassword access helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setActivePinia(createPinia());
  });

  it("hides connections of a locked group and keeps reachable ones", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { filterConnectionsOutsideLockedGroups } = await import("@/lib/sidebar/connectionGroupPassword");

    expect(filterConnectionsOutsideLockedGroups([{ id: "grouped" }, { id: "root" }])).toEqual([{ id: "root" }]);
  });

  it("keeps connections of an unprotected group", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup();
    const { filterConnectionsOutsideLockedGroups } = await import("@/lib/sidebar/connectionGroupPassword");

    expect(filterConnectionsOutsideLockedGroups([{ id: "grouped" }, { id: "root" }])).toEqual([{ id: "grouped" }, { id: "root" }]);
  });

  it("reveals a locked group's connections after an in-session unlock", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { filterConnectionsOutsideLockedGroups } = await import("@/lib/sidebar/connectionGroupPassword");

    expect(filterConnectionsOutsideLockedGroups([{ id: "grouped" }])).toEqual([]);
    store.unlockConnectionGroup("project");
    expect(filterConnectionsOutsideLockedGroups([{ id: "grouped" }])).toEqual([{ id: "grouped" }]);
  });

  it("resolves the gating group only for locked groups", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { lockedConnectionGroupForConnection } = await import("@/lib/sidebar/connectionGroupPassword");

    expect(lockedConnectionGroupForConnection("grouped")?.id).toBe("project");
    expect(lockedConnectionGroupForConnection("root")).toBeNull();
    expect(lockedConnectionGroupForConnection("missing")).toBeNull();

    store.unlockConnectionGroup("project");
    expect(lockedConnectionGroupForConnection("grouped")).toBeNull();
  });

  it("lets reachable connections through without prompting", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup();
    const { ensureConnectionGroupAccessible } = await import("@/lib/sidebar/connectionGroupPassword");
    const { useConnectionGroupPasswordPromptStore } = await import("@/stores/connectionGroupPasswordPromptStore");

    await expect(ensureConnectionGroupAccessible("grouped")).resolves.toBe(true);
    await expect(ensureConnectionGroupAccessible("missing")).resolves.toBe(true);
    expect(useConnectionGroupPasswordPromptStore().current).toBeNull();
  });

  it("gates opening a locked connection behind the prompt and unlocks on success", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { ensureConnectionGroupAccessible } = await import("@/lib/sidebar/connectionGroupPassword");
    const { useConnectionGroupPasswordPromptStore } = await import("@/stores/connectionGroupPasswordPromptStore");

    const pending = ensureConnectionGroupAccessible("grouped");
    const promptStore = useConnectionGroupPasswordPromptStore();
    expect(promptStore.current?.groupId).toBe("project");
    promptStore.resolve(true);

    await expect(pending).resolves.toBe(true);
    expect(store.isConnectionGroupUnlocked("project")).toBe(true);
  });

  it("keeps the group locked when the password prompt is dismissed", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { ensureConnectionGroupAccessible } = await import("@/lib/sidebar/connectionGroupPassword");
    const { useConnectionGroupPasswordPromptStore } = await import("@/stores/connectionGroupPasswordPromptStore");

    const pending = ensureConnectionGroupAccessible("grouped");
    useConnectionGroupPasswordPromptStore().resolve(false);

    await expect(pending).resolves.toBe(false);
    expect(store.isConnectionGroupUnlocked("project")).toBe(false);
  });

  it("lists ids of locked groups and drops them after an in-session unlock", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup({ passwordHash: PROTECTION_HASH });
    const { lockedConnectionGroupIds } = await import("@/lib/sidebar/connectionGroupPassword");

    expect([...lockedConnectionGroupIds()]).toEqual(["project"]);
    store.unlockConnectionGroup("project");
    expect([...lockedConnectionGroupIds()]).toEqual([]);
  });

  it("reports no locked ids for unprotected groups", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.sidebarLayout = layoutWithGroup();
    const { lockedConnectionGroupIds } = await import("@/lib/sidebar/connectionGroupPassword");

    expect([...lockedConnectionGroupIds()]).toEqual([]);
  });
});
