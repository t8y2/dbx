import { shallowRef } from "vue";
import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/types/database";

import { useSidebarTreeToolRuntime } from "@/composables/useSidebarTreeToolRuntime";

function setup(node: Partial<TreeNode>) {
  const activeNode = shallowRef({ id: "n-1", label: "node", children: [], ...node } as TreeNode);
  const connectionStore = { docsSource: null as unknown };
  const runtime = useSidebarTreeToolRuntime({
    activeNode,
    connectionStore: connectionStore as never,
    queryStore: {} as never,
    settingsStore: {} as never,
    tableChildObjectName: () => "",
  });
  return { connectionStore, runtime };
}

describe("useSidebarTreeToolRuntime openDocs", () => {
  it("documents the whole database when invoked on a database node", () => {
    const { connectionStore, runtime } = setup({ type: "database", label: "shop", connectionId: "conn-1", database: "shop" });

    runtime.openDocs();

    // An absent schema is what makes the collector document every schema.
    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: undefined });
  });

  it("narrows to a single schema when invoked on a schema node", () => {
    const { connectionStore, runtime } = setup({ type: "schema", label: "public", connectionId: "conn-1", database: "shop", schema: "public" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toEqual({ connectionId: "conn-1", database: "shop", schema: "public" });
  });

  it("does nothing when the node carries no database", () => {
    const { connectionStore, runtime } = setup({ type: "connection", label: "local", connectionId: "conn-1" });

    runtime.openDocs();

    expect(connectionStore.docsSource).toBeNull();
  });
});
