import { describe, expect, it } from "vitest";
import { sidebarTreeSecondaryValue, sidebarTreeObjectCountText } from "@/lib/sidebar/sidebarTreeLabel";
import { projectRelationalNavigationGroups, type RelationalNavigationSource } from "@/lib/sidebar/relationalNavigationTree";
import { oracleNavigationAuxiliaryText } from "@/lib/sidebar/oracleObjectNavigation";

const source = (name: string, shared = false): RelationalNavigationSource => ({
  name,
  shared,
  node: {
    id: `${name}-links`,
    type: "oracle-db-links",
    label: "tree.databaseLinks",
    connectionId: "c",
    database: "db",
    schema: shared ? undefined : name,
    databaseLinkScope: shared ? { kind: "public" } : { kind: "schema", schema: name },
    objectCount: 1,
    children: [{ id: `${name}-L`, type: "oracle-db-link", label: "L", connectionId: "c", database: "db", schema: shared ? undefined : name, databaseLinkScope: shared ? { kind: "public" } : { kind: "schema", schema: name } }],
  },
});
const project = (sources: RelationalNavigationSource[], overrides: Partial<Parameters<typeof projectRelationalNavigationGroups>[0]> = {}) =>
  projectRelationalNavigationGroups({ container: { connectionId: "c", database: "db", kind: "schema" }, selection: { kind: "all" }, sources, discoveryComplete: true, isLoaded: () => true, expandedIds: new Set(), ...overrides });

describe("relational navigation projection", () => {
  it("leaves unknown, loading or paged counts blank and only confirms an actual zero", () => {
    const node = source("A").node;
    expect(sidebarTreeObjectCountText({ ...node, objectCount: undefined })).toBe("");
    expect(sidebarTreeObjectCountText({ ...node, isLoading: true })).toBe("");
    expect(sidebarTreeObjectCountText({ ...node, objectCount: 0 })).toBe("0");
    expect(sidebarTreeObjectCountText({ ...node, children: [{ id: "more", type: "load-more", label: "more" }] })).toBe("");
    expect(sidebarTreeObjectCountText({ ...node, hiddenChildren: [{ id: "more", type: "load-more", label: "more" }] })).toBe("");
  });
  it("merges same-name objects without changing executable identities or mutating sources", () => {
    const sources = [source("A"), source("B"), source("PUBLIC", true)];
    const before = JSON.stringify(sources);
    const [group] = project(sources);
    expect(group.objectCount).toBe(3);
    expect(group.children?.map((child) => [child.id, child.schema, child.relationalNavigationOwner])).toEqual([
      ["A-L", "A", "A"],
      ["B-L", "B", "B"],
      ["PUBLIC-L", undefined, "PUBLIC"],
    ]);
    expect(group.databaseLinkScope).toBeUndefined();
    expect(sidebarTreeSecondaryValue(group.children![2], (key) => key)).toBe("PUBLIC");
    expect(JSON.stringify(sources)).toBe(before);
  });
  it("includes shared objects once in single scope and omits repeated owner labels", () => {
    const shared = source("PUBLIC", true);
    const [group] = project([source("A"), source("B"), shared, shared], { selection: { kind: "named", name: "A" } });
    expect(group.children?.map((child) => [child.id, child.relationalNavigationOwner])).toEqual([
      ["A-L", undefined],
      ["PUBLIC-L", "PUBLIC"],
    ]);
    expect(group.objectCount).toBe(2);
  });
  it("never reports a complete count with partial discovery, pagination or a failed source", () => {
    expect(project([source("A")], { discoveryComplete: false })[0].objectCount).toBeUndefined();
    const paged = source("A");
    paged.node.children!.push({ id: "more", type: "load-more", label: "more", loadMore: { parentId: paged.node.id, offset: 1, pageSize: 1 } });
    const [group] = project([paged]);
    expect(group.objectCount).toBeUndefined();
    expect(group.children?.[1].loadMore?.parentId).toBe("A-links");
    const failed = source("B");
    failed.node.oracleNavigationStatus = { kind: "denied", reason: "denied" };
    expect(project([source("A"), failed])[0].oracleNavigationStatus?.kind).toBe("denied");
    expect(project([source("A"), failed])[0].objectCount).toBeUndefined();
  });
  it("identifies failed source scopes and renders explicit failure text for ordinary projected directories", () => {
    const a = source("A");
    const b = source("B");
    a.node.type = b.node.type = "group-tables";
    a.node.oracleNavigationStatus = { kind: "denied", reason: "permission denied" };
    b.node.oracleNavigationStatus = { kind: "error", reason: "directory unavailable" };
    const [group] = project([a, b]);
    expect(group.oracleNavigationStatus).toEqual({ kind: "denied", reason: "A: permission denied\nB: directory unavailable" });
    expect(oracleNavigationAuxiliaryText(group, (key) => key)).toBe("tree.navigationStatus.denied");
    expect(group.objectCount).toBeUndefined();
    expect(group.children).toHaveLength(2);
  });
  it("keeps scheduler hierarchy and exact job scope", () => {
    const scheduler = (name: string): RelationalNavigationSource => ({
      name,
      node: {
        id: `${name}-scheduler`,
        label: "tree.scheduler",
        type: "native-job-scheduler",
        children: [
          {
            id: `${name}-jobs`,
            label: "tree.jobs",
            type: "native-job-group",
            nativeJobPage: { schema: name, kind: "scheduler" },
            children: [{ id: `${name}-job`, label: "same", type: "native-job", nativeJobPage: { schema: name, kind: "scheduler" }, nativeJobSelection: { kind: "scheduler", owner: name, name: "same" } }],
            objectCount: 1,
          },
        ],
      },
    });
    const groups = project([scheduler("A"), scheduler("B")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].children?.[0].children?.map((child) => child.nativeJobSelection)).toEqual([
      { kind: "scheduler", owner: "A", name: "same" },
      { kind: "scheduler", owner: "B", name: "same" },
    ]);
  });
  it("isolates aggregate ids by parent catalog", () => {
    expect(project([source("A")])[0].id).not.toBe(project([source("A")], { container: { connectionId: "c", database: "db", catalog: "other", kind: "schema" } })[0].id);
  });
});
