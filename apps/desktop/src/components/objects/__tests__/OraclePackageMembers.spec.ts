// @vitest-environment happy-dom

import { createApp, h, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import OraclePackageMembers from "@/components/objects/OraclePackageMembers.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import type { OraclePackageMemberEntry } from "@/lib/sql/oraclePackageMembers";

const api = vi.hoisted(() => ({ getObjectSource: vi.fn(), executeQuery: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);

const source = `CREATE PACKAGE TEST_OWNER.SAMPLE_PKG AS
  PROCEDURE run_task;
  FUNCTION read_task RETURN NUMBER;
END;`;

function buttonWithLabel(label: string, parent: ParentNode = document) {
  return [...parent.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
}

function rightClick(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
  return nextTick();
}

describe("Oracle package member context menu", () => {
  it("previews a procedure from the menu and waits for explicit execution", async () => {
    const navigate = vi.fn();
    const execute = vi.fn();
    api.getObjectSource.mockResolvedValue({ source });
    let finishMetadata!: (value: unknown) => void;
    api.executeQuery.mockImplementation(() => new Promise((resolve) => (finishMetadata = resolve)));
    const selected = ref<OraclePackageMemberEntry>();
    const open = ref(false);
    const app = createApp({
      setup: () => () => [
        h(OraclePackageMembers, {
          source,
          canExecuteProcedure: true,
          onNavigate: navigate,
          onExecuteProcedure: (member) => {
            selected.value = member;
            open.value = true;
          },
        }),
        selected.value &&
          h(ProcedureExecutionDialog, {
            open: open.value,
            "onUpdate:open": (value) => (open.value = value),
            connectionId: "connection-1",
            database: "app",
            schema: "TEST_OWNER",
            databaseType: "oracle",
            routineName: selected.value.databaseName,
            packageProcedure: { connectionId: "connection-1", database: "app", schema: "TEST_OWNER", packageName: "SAMPLE_PKG", member: selected.value },
            onExecute: execute,
          }),
      ],
    });
    const host = document.createElement("div");
    document.body.append(host);
    app.use(i18n).mount(host);

    try {
      await rightClick(buttonWithLabel("ƒread_task3", host)!);
      expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();
      const procedure = buttonWithLabel("Prun_task2", host)!;
      procedure.click();
      expect(navigate).toHaveBeenCalledOnce();
      expect(api.getObjectSource).not.toHaveBeenCalled();
      await rightClick(procedure);
      const executeLabel = i18n.global.t("contextMenu.executeProcedure");
      buttonWithLabel(executeLabel, document.querySelector("[data-dbx-context-menu]")!)!.click();
      const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
      await vi.waitFor(() => expect(dialog()).not.toBeNull());
      expect(buttonWithLabel(executeLabel, dialog()!)?.disabled).toBe(true);
      expect(execute).not.toHaveBeenCalled();

      finishMetadata({ columns: [], rows: [[null, null, null, null, null, 1]], affected_rows: 0, execution_time_ms: 0 });
      const sql = 'BEGIN\n  "TEST_OWNER"."SAMPLE_PKG"."RUN_TASK"();\nEND;';
      await vi.waitFor(() => expect(dialog()?.querySelector("textarea")?.value).toBe(sql));
      buttonWithLabel(executeLabel, dialog()!)!.click();
      expect(execute).toHaveBeenCalledExactlyOnceWith(sql);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
