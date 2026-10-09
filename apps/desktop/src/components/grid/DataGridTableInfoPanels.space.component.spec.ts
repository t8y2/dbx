import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import DataGridTableInfoPanels from "./DataGridTableInfoPanels.vue";
import en from "@/i18n/locales/en";

describe("table information OceanBase space", () => {
  it("renders separate source, Leader, index and unknown LOB values in the real overview", () => {
    const wrapper = mount(DataGridTableInfoPanels, {
      props: {
        activeTab: "overview", searchQuery: "", tableName: "T", tableSchema: "A", database: "db", tableOwner: "A",
        overviewStats: { name: "T", schema: "A", estimated_rows: 8, space: {
          status: "available", source: "SYS.DBA_OB_TABLE_SPACE_USAGE", replica_scope: "leader",
          data_bytes: 0, allocated_bytes: 8192, components_status: "available",
          components: [{ kind: "INDEX", data_bytes: 20, allocated_bytes: 4096 }],
        } },
        overviewComment: null, overviewLoading: false, columns: [], columnsLoading: false,
        indexes: [], indexesLoading: false, indexesError: "", canManageMongoIndexes: false,
        foreignKeys: [], foreignKeysLoading: false, foreignKeysError: "", triggers: [], triggersLoading: false, triggersError: "",
        constraints: [], constraintsLoading: false, constraintsError: "", partitioning: null, partitionsLoading: false, partitionsError: "",
        isProtectedMongoIndex: () => false, formatColumnType: (value: string) => value,
      },
      global: { plugins: [createI18n({ legacy: false, locale: "en", messages: { en } })] },
    });
    expect(wrapper.text()).toContain("SYS.DBA_OB_TABLE_SPACE_USAGE");
    expect(wrapper.text()).toContain("Leader only");
    expect(wrapper.text()).toContain("0 B");
    expect(wrapper.text()).toContain("8.00 KB");
    expect(wrapper.text()).toContain("4.00 KB");
    expect(wrapper.text()).toContain("LOB auxiliary partitions");
    expect(wrapper.text()).toContain("Unknown");
    wrapper.unmount();
  });
});
