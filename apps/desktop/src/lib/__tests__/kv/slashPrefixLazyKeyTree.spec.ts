import { describe, expect, it } from "vitest";
import { createLazyKvKeyTreeState, replaceLazyKvChildren } from "@/lib/kv/slashPrefixLazyKeyTree";

describe("slashPrefixLazyKeyTree", () => {
  it("treats a trailing-slash Consul Key with no children as a leaf after expansion", () => {
    const state = createLazyKvKeyTreeState("", "relative");
    replaceLazyKvChildren(state, null, [{ key: "feature/", hasValue: true }], null);

    const node = state.nodeByKey.get("feature/");
    expect(node?.hasChildren).toBe(true);

    replaceLazyKvChildren(state, "feature/", [], null, { filteredByAcls: false });
    expect(state.nodeByKey.get("feature/")?.hasChildren).toBe(false);
  });

  it("keeps the directory affordance when ACL filtering makes an empty listing inconclusive", () => {
    const state = createLazyKvKeyTreeState("", "relative");
    replaceLazyKvChildren(state, null, [{ key: "feature/", hasValue: true }], null);

    replaceLazyKvChildren(state, "feature/", [], null, { filteredByAcls: true });
    expect(state.nodeByKey.get("feature/")?.hasChildren).toBe(true);
  });
});
