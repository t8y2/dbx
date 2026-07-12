import { describe, expect, it } from "vitest";
import { appendJsonPointer, createJsonTreeRoot, getJsonTreeChildren, getVisibleJsonTreeNodes, isJsonTreeContainer, isJsonTreeInitiallyExpanded } from "../jsonTree";
import { parseJsonPreservingLargeNumbers } from "../safeJsonFormat";

describe("jsonTree", () => {
  it("uses RFC 6901 paths for object keys and array positions", () => {
    const root = createJsonTreeRoot({ "a/b~c": ["value"] });
    const objectChild = getJsonTreeChildren(root)[0];
    const arrayChild = getJsonTreeChildren(objectChild)[0];

    expect(root.path).toBe("");
    expect(objectChild.path).toBe("/a~1b~0c");
    expect(arrayChild.path).toBe("/a~1b~0c/0");
    expect(appendJsonPointer("/parent", "a/b~c")).toBe("/parent/a~1b~0c");
  });

  it("keeps lossless JSON numbers as scalar nodes", () => {
    const value = parseJsonPreservingLargeNumbers('{"id":518400931654815740}') as Record<string, unknown>;
    const child = getJsonTreeChildren(createJsonTreeRoot(value))[0];

    expect(isJsonTreeContainer(child.value)).toBe(false);
  });

  it("treats initial depth as expanded container levels from the root", () => {
    expect(isJsonTreeInitiallyExpanded(0, 2)).toBe(true);
    expect(isJsonTreeInitiallyExpanded(1, 2)).toBe(true);
    expect(isJsonTreeInitiallyExpanded(2, 2)).toBe(false);
    expect(isJsonTreeInitiallyExpanded(99, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("flattens expanded branches iteratively for virtual rendering", () => {
    const root = createJsonTreeRoot({ first: { nested: true }, second: ["kept"] });
    const nodes = getVisibleJsonTreeNodes(root, (node) => node.path !== "/first");

    expect(nodes.map((node) => node.path)).toEqual(["", "/first", "/second", "/second/0"]);
  });

  it("handles deeply nested expanded JSON without recursive traversal", () => {
    let value: unknown = true;
    for (let depth = 0; depth < 2_000; depth += 1) value = { child: value };

    const nodes = getVisibleJsonTreeNodes(createJsonTreeRoot(value), () => true);

    expect(nodes).toHaveLength(2_001);
  });
});
