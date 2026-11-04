// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive, ref } from "vue";
import { parentHasSearchableTableList, resolveLocalTableSearchParent, tableSearchControlId } from "@/lib/sidebar/sidebarTableSearchControl";
import type { TreeNode } from "@/types/database";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

const compiled = compileConnectionTreeTestScript(["latestLocalTableSearchFocusRequestId", "focusGlobalSearch", "findLocalTableSearchInput", "focusSearch"]);

function createTestEnvironment(
  options: {
    sidebarTableSearchEnabled?: boolean;
    sidebarObjectDisplay?: "simple" | "grouped";
  } = {},
) {
  const root = document.createElement("div");
  document.body.append(root);

  const globalSearchInput = document.createElement("input");
  globalSearchInput.className = "global-search-input";
  vi.spyOn(globalSearchInput, "focus");
  vi.spyOn(globalSearchInput, "select");
  root.append(globalSearchInput);

  const searchInputRef = { value: globalSearchInput };
  const settingsStore = reactive({
    editorSettings: {
      sidebarTableSearchEnabled: options.sidebarTableSearchEnabled ?? true,
      sidebarObjectDisplay: options.sidebarObjectDisplay ?? "simple",
    },
  });

  const store = reactive({
    treeNodes: [] as TreeNode[],
    selectedTreeNodeId: null as string | null,
  });

  const activeTab = ref<{ id: string } | null>({ id: "tab-1" });
  const flatNodes = ref<any[]>([]);
  const flatNodeIndexById = reactive(new Map<string, number>());
  const flatTreeIndex = ref({ flatNodeIndexById });

  const toggleNodeMock = vi.fn();
  const sidebarTreeRuntimeHostRef = {
    value: {
      toggleNode: toggleNodeMock,
    },
  };

  const scrollToSidebarNodeMock = vi.fn(async () => {});
  const waitForSidebarRenderFrame = vi.fn(async () => {
    await nextTick();
  });

  const findSidebarNodeForActiveTab = vi.fn(() => null);

  const bindings = {
    CSS,
    Date,
    HTMLInputElement,
    activeTab,
    findLocalTableSearchInput: undefined,
    findSidebarNodeForActiveTab,
    flatNodes,
    flatTreeIndex,
    focusGlobalSearch: undefined,
    focusSearch: undefined,
    nextTick,
    parentHasSearchableTableList,
    resolveLocalTableSearchParent,
    rootRef: { value: root },
    scrollToSidebarNode: scrollToSidebarNodeMock,
    searchInputRef,
    settingsStore,
    sidebarTreeRuntimeHostRef,
    store,
    tableSearchControlId,
    waitForSidebarRenderFrame,
  };

  const instantiated = new Function(...Object.keys(bindings), `${compiled}; return { focusSearch, focusGlobalSearch, findLocalTableSearchInput };`)(...Object.values(bindings)) as {
    focusSearch: (target?: Element | null) => boolean;
    focusGlobalSearch: () => boolean;
    findLocalTableSearchInput: (parent: TreeNode) => HTMLInputElement | null;
  };

  return {
    root,
    globalSearchInput,
    settingsStore,
    store,
    activeTab,
    flatNodeIndexById,
    toggleNodeMock,
    scrollToSidebarNodeMock,
    focusSearch: instantiated.focusSearch,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ConnectionTree Ctrl+F table search focus", () => {
  describe("Scenario 1: Routine-only schema", () => {
    it("falls back to global search when schema only contains routines in simple mode", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const routineSchema: TreeNode = {
        id: "conn:pg:db:routines_only",
        label: "routines_only",
        type: "schema",
        connectionId: "conn:pg",
        database: "mydb",
        schema: "routines_only",
        isExpanded: true,
        children: [
          {
            id: "conn:pg:db:routines_only:fn1",
            label: "fn1",
            type: "function",
            connectionId: "conn:pg",
            database: "mydb",
            schema: "routines_only",
          },
        ],
      };
      env.store.treeNodes = [
        {
          id: "conn:pg",
          label: "Postgres",
          type: "connection",
          connectionId: "conn:pg",
          children: [
            {
              id: "conn:pg:db",
              label: "mydb",
              type: "database",
              connectionId: "conn:pg",
              database: "mydb",
              children: [routineSchema],
            },
          ],
        },
      ];
      env.store.selectedTreeNodeId = routineSchema.id;

      const result = env.focusSearch();

      expect(result).toBe(true);
      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
      expect(env.globalSearchInput.select).toHaveBeenCalledOnce();
      expect(env.toggleNodeMock).not.toHaveBeenCalled();
    });

    it("falls back to global search when routine under schema is selected in simple mode", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const routineSchema: TreeNode = {
        id: "conn:pg:db:routines_only",
        label: "routines_only",
        type: "schema",
        connectionId: "conn:pg",
        database: "mydb",
        schema: "routines_only",
        isExpanded: true,
        children: [
          {
            id: "conn:pg:db:routines_only:fn1",
            label: "fn1",
            type: "function",
            connectionId: "conn:pg",
            database: "mydb",
            schema: "routines_only",
          },
        ],
      };
      env.store.treeNodes = [
        {
          id: "conn:pg",
          label: "Postgres",
          type: "connection",
          connectionId: "conn:pg",
          children: [
            {
              id: "conn:pg:db",
              label: "mydb",
              type: "database",
              connectionId: "conn:pg",
              database: "mydb",
              children: [routineSchema],
            },
          ],
        },
      ];
      env.store.selectedTreeNodeId = "conn:pg:db:routines_only:fn1";

      const result = env.focusSearch();

      expect(result).toBe(true);
      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
    });

    it("falls back to global search when database has no group-tables in grouped mode", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "grouped" });
      env.store.treeNodes = [
        {
          id: "conn:pg",
          label: "Postgres",
          type: "connection",
          connectionId: "conn:pg",
          children: [
            {
              id: "conn:pg:db",
              label: "mydb",
              type: "database",
              connectionId: "conn:pg",
              database: "mydb",
              isExpanded: true,
              children: [
                {
                  id: "conn:pg:db:__procs",
                  label: "Procedures",
                  type: "group-procedures",
                  connectionId: "conn:pg",
                  database: "mydb",
                  isExpanded: true,
                  children: [
                    {
                      id: "conn:pg:db:proc1",
                      label: "proc1",
                      type: "procedure",
                      connectionId: "conn:pg",
                      database: "mydb",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      env.store.selectedTreeNodeId = "conn:pg:db";

      const result = env.focusSearch();

      expect(result).toBe(true);
      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
      expect(env.toggleNodeMock).not.toHaveBeenCalled();
    });
  });

  describe("Scenario 2: Disabled local table search", () => {
    it("preserves user preference and falls back to global search without modifying settings", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: false, sidebarObjectDisplay: "simple" });
      const tableDatabase: TreeNode = {
        id: "conn:1:db",
        label: "mydb",
        type: "database",
        connectionId: "conn:1",
        database: "mydb",
        isExpanded: true,
        children: [
          {
            id: "conn:1:db:users",
            label: "users",
            type: "table",
            connectionId: "conn:1",
            database: "mydb",
          },
        ],
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [tableDatabase],
        },
      ];
      env.store.selectedTreeNodeId = tableDatabase.id;

      const result = env.focusSearch();

      expect(result).toBe(true);
      expect(env.settingsStore.editorSettings.sidebarTableSearchEnabled).toBe(false);
      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
      expect(env.toggleNodeMock).not.toHaveBeenCalled();
    });
  });

  describe("Scenario 3: Collapsed and slow-loading database", () => {
    it("expands collapsed database, waits for control to appear, and focuses local input", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_slow",
        label: "db_slow",
        type: "database",
        connectionId: "conn:1",
        database: "db_slow",
        isExpanded: false,
        // children undefined initially
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      // Mock toggleNode triggering an asynchronous slow load
      const localInput = document.createElement("input");
      localInput.dataset.sidebarTableSearchParentId = collapsedDatabase.id;
      vi.spyOn(localInput, "focus");
      vi.spyOn(localInput, "select");

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        node.isExpanded = true;
        node.isLoading = true;
        // Simulate slow metadata arrival after 30ms
        setTimeout(() => {
          node.children = [
            {
              id: "conn:1:db_slow:orders",
              label: "orders",
              type: "table",
              connectionId: "conn:1",
              database: "db_slow",
            },
          ];
          node.isLoading = false;
          const controlId = tableSearchControlId(collapsedDatabase.id);
          env.flatNodeIndexById.set(controlId, 1);
          env.root.append(localInput);
        }, 30);
      });

      const result = env.focusSearch();
      expect(result).toBe(true);
      expect(env.toggleNodeMock).toHaveBeenCalledWith(collapsedDatabase);

      // Wait for the slow load to complete
      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      expect(localInput.focus).toHaveBeenCalledOnce();
      expect(localInput.select).toHaveBeenCalledOnce();
      expect(env.globalSearchInput.focus).not.toHaveBeenCalled();
    });

    it("expands collapsed database in grouped mode, reveals child group-tables control, and focuses input", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "grouped" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_grouped_slow",
        label: "db_grouped_slow",
        type: "database",
        connectionId: "conn:1",
        database: "db_grouped_slow",
        isExpanded: false,
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      const groupTablesId = `${collapsedDatabase.id}:__tables`;
      const localInput = document.createElement("input");
      localInput.dataset.sidebarTableSearchParentId = groupTablesId;
      vi.spyOn(localInput, "focus");
      vi.spyOn(localInput, "select");

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        if (node.id === collapsedDatabase.id) {
          node.isExpanded = true;
          node.isLoading = true;
          setTimeout(() => {
            node.children = [
              {
                id: groupTablesId,
                label: "Tables",
                type: "group-tables",
                connectionId: "conn:1",
                database: "db_grouped_slow",
                isExpanded: true,
                children: [
                  {
                    id: `${groupTablesId}:orders`,
                    label: "orders",
                    type: "table",
                    connectionId: "conn:1",
                    database: "db_grouped_slow",
                  },
                ],
              },
            ];
            node.isLoading = false;
            const controlId = tableSearchControlId(groupTablesId);
            env.flatNodeIndexById.set(controlId, 1);
            env.root.append(localInput);
          }, 30);
        }
      });

      const result = env.focusSearch();
      expect(result).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      expect(localInput.focus).toHaveBeenCalledOnce();
      expect(localInput.select).toHaveBeenCalledOnce();
      expect(env.globalSearchInput.focus).not.toHaveBeenCalled();
    });

    it("falls back to global search when slow-loading database finishes loading without tables", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_empty",
        label: "db_empty",
        type: "database",
        connectionId: "conn:1",
        database: "db_empty",
        isExpanded: false,
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        node.isExpanded = true;
        node.isLoading = true;
        setTimeout(() => {
          node.children = []; // loaded but empty
          node.isLoading = false;
        }, 30);
      });

      const result = env.focusSearch();
      expect(result).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
    });

    it("cancels stale focus request when user switches active tab during slow loading", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_slow",
        label: "db_slow",
        type: "database",
        connectionId: "conn:1",
        database: "db_slow",
        isExpanded: false,
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      const localInput = document.createElement("input");
      localInput.dataset.sidebarTableSearchParentId = collapsedDatabase.id;
      vi.spyOn(localInput, "focus");

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        node.isExpanded = true;
        node.isLoading = true;
        setTimeout(() => {
          node.children = [{ id: "conn:1:db_slow:t1", label: "t1", type: "table", connectionId: "conn:1", database: "db_slow" }];
          node.isLoading = false;
          const controlId = tableSearchControlId(collapsedDatabase.id);
          env.flatNodeIndexById.set(controlId, 1);
          env.root.append(localInput);
        }, 40);
      });

      const result = env.focusSearch();
      expect(result).toBe(true);

      // User switches tab after 10ms
      await new Promise((resolve) => setTimeout(resolve, 10));
      env.activeTab.value = { id: "tab-2" };

      // Wait for slow load to finish
      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      // Focus request was cancelled; neither local input nor global search was focused
      expect(localInput.focus).not.toHaveBeenCalled();
      expect(env.globalSearchInput.focus).not.toHaveBeenCalled();
    });

    it("cancels stale focus request when user changes tree selection during slow loading", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_slow",
        label: "db_slow",
        type: "database",
        connectionId: "conn:1",
        database: "db_slow",
        isExpanded: false,
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      const localInput = document.createElement("input");
      localInput.dataset.sidebarTableSearchParentId = collapsedDatabase.id;
      vi.spyOn(localInput, "focus");

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        node.isExpanded = true;
        node.isLoading = true;
        setTimeout(() => {
          node.children = [{ id: "conn:1:db_slow:t1", label: "t1", type: "table", connectionId: "conn:1", database: "db_slow" }];
          node.isLoading = false;
          const controlId = tableSearchControlId(collapsedDatabase.id);
          env.flatNodeIndexById.set(controlId, 1);
          env.root.append(localInput);
        }, 40);
      });

      const result = env.focusSearch();
      expect(result).toBe(true);

      // User selects another node
      await new Promise((resolve) => setTimeout(resolve, 10));
      env.store.selectedTreeNodeId = "other_node_id";

      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      expect(localInput.focus).not.toHaveBeenCalled();
      expect(env.globalSearchInput.focus).not.toHaveBeenCalled();
    });

    it("cancels a pending local focus after the user requests disabled-local global search", async () => {
      const env = createTestEnvironment({ sidebarTableSearchEnabled: true, sidebarObjectDisplay: "simple" });
      const collapsedDatabase: TreeNode = {
        id: "conn:1:db_slow",
        label: "db_slow",
        type: "database",
        connectionId: "conn:1",
        database: "db_slow",
        isExpanded: false,
      };
      env.store.treeNodes = [
        {
          id: "conn:1",
          label: "MySQL",
          type: "connection",
          connectionId: "conn:1",
          children: [collapsedDatabase],
        },
      ];
      env.store.selectedTreeNodeId = collapsedDatabase.id;

      const localInput = document.createElement("input");
      localInput.dataset.sidebarTableSearchParentId = collapsedDatabase.id;
      vi.spyOn(localInput, "focus");

      env.toggleNodeMock.mockImplementation((node: TreeNode) => {
        node.isExpanded = true;
        node.isLoading = true;
        setTimeout(() => {
          node.children = [{ id: "conn:1:db_slow:t1", label: "t1", type: "table", connectionId: "conn:1", database: "db_slow" }];
          node.isLoading = false;
          const controlId = tableSearchControlId(collapsedDatabase.id);
          env.flatNodeIndexById.set(controlId, 1);
          env.root.append(localInput);
        }, 40);
      });

      const result = env.focusSearch();
      expect(result).toBe(true);

      // User selects another node
      await new Promise((resolve) => setTimeout(resolve, 10));
      env.settingsStore.editorSettings.sidebarTableSearchEnabled = false;
      expect(env.focusSearch()).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTick();

      expect(localInput.focus).not.toHaveBeenCalled();
      expect(env.globalSearchInput.focus).toHaveBeenCalledOnce();
    });
  });
});
