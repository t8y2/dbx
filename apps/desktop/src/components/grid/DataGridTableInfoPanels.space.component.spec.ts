// @vitest-environment happy-dom

import { createApp, h } from "vue";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import DataGridTableInfoPanels from "./DataGridTableInfoPanels.vue";
import en from "@/i18n/locales/en";

describe("table information OceanBase space", () => {
  it("renders separate source, Leader, index and unknown LOB values in the real overview", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(DataGridTableInfoPanels, {
          activeTab: "info",
          searchQuery: "",
          tableName: "T",
          tableSchema: "A",
          database: "db",
          tableOwner: "A",
          overviewStats: {
            name: "T",
            schema: "A",
            estimated_rows: 8,
            space: {
              status: "available",
              source: "SYS.DBA_OB_TABLE_SPACE_USAGE",
              replica_scope: "leader",
              data_bytes: 0,
              allocated_bytes: 8192,
              components_status: "available",
              components: [{ kind: "INDEX", data_bytes: 20, allocated_bytes: 4096 }],
            },
          },
          overviewComment: null,
          overviewLoading: false,
          columns: [],
          columnsLoading: false,
          indexes: [],
          indexesLoading: false,
          indexesError: "",
          canManageMongoIndexes: false,
          foreignKeys: [],
          foreignKeysLoading: false,
          foreignKeysError: "",
          triggers: [],
          triggersLoading: false,
          triggersError: "",
          constraints: [],
          constraintsLoading: false,
          constraintsError: "",
          partitioning: null,
          partitionsLoading: false,
          partitionsError: "",
          isProtectedMongoIndex: () => false,
          formatColumnType: (value: string) => value,
        }),
    });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
    try {
      app.mount(host);
      expect(host.textContent).toContain("SYS.DBA_OB_TABLE_SPACE_USAGE");
      expect(host.textContent).toContain("Leader only");
      expect(host.textContent).toContain("0 B");
      expect(host.textContent).toContain("8.00 KB");
      expect(host.textContent).toContain("4.00 KB");
      expect(host.textContent).toContain("LOB auxiliary partitions");
      expect(host.textContent).toContain("Unknown");
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
