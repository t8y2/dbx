import { describe, expect, it } from "vitest";
import { reactive, ref, toRefs } from "vue";
import { createRoutedSidebarDialogController } from "@/components/sidebar/sidebarDialogControllerRouting";

describe("createRoutedSidebarDialogController", () => {
  it("keeps dialog open flags linked to the shared module refs", () => {
    const showCreateDatabaseDialog = ref(false);
    const createDatabaseName = ref("");
    const controller = reactive({
      showCreateDatabaseDialog,
      createDatabaseName,
      confirmCreateDatabase: () => "ok",
    });

    let wrappedCalls = 0;
    const routed = createRoutedSidebarDialogController(controller, {
      node: { id: "connection:1" },
      wrapAction: (action) => {
        return (...args) => {
          wrappedCalls += 1;
          return action(...args);
        };
      },
    });

    const { showCreateDatabaseDialog: dialogOpen, createDatabaseName: dialogName } = toRefs(routed);

    showCreateDatabaseDialog.value = true;
    expect(dialogOpen.value).toBe(true);

    dialogOpen.value = false;
    expect(showCreateDatabaseDialog.value).toBe(false);

    dialogName.value = "analytics";
    expect(createDatabaseName.value).toBe("analytics");

    expect(routed.confirmCreateDatabase()).toBe("ok");
    expect(wrappedCalls).toBe(1);
    expect(routed.node).toEqual({ id: "connection:1" });
  });

  it("does not leave shared open flags stuck after a disconnected-style cancel", () => {
    const showCreateDatabaseDialog = ref(false);
    const controller = reactive({ showCreateDatabaseDialog });

    // Reproduce the old bug: spreading a reactive proxy unwraps refs.
    const broken = reactive({ ...controller, node: { id: "connection:1" } });
    showCreateDatabaseDialog.value = true;
    expect(broken.showCreateDatabaseDialog).toBe(false);
    broken.showCreateDatabaseDialog = false;
    expect(showCreateDatabaseDialog.value).toBe(true);

    // Fixed routing keeps cancel and open in sync.
    const routed = createRoutedSidebarDialogController(controller, {
      node: { id: "connection:1" },
      wrapAction: (action) => action,
    });
    showCreateDatabaseDialog.value = true;
    expect(routed.showCreateDatabaseDialog).toBe(true);
    routed.showCreateDatabaseDialog = false;
    expect(showCreateDatabaseDialog.value).toBe(false);
  });
});
