import { defineAsyncComponent, type Component } from "vue";
import SidebarAsyncDialogError from "./SidebarAsyncDialogError.vue";
import SidebarAsyncDialogLoading from "./SidebarAsyncDialogLoading.vue";

function lazySidebarDialog(loader: () => Promise<Component>) {
  return defineAsyncComponent({
    loader,
    loadingComponent: SidebarAsyncDialogLoading,
    errorComponent: SidebarAsyncDialogError,
    delay: 120,
    timeout: 15_000,
    onError(_error, retry, fail, attempts) {
      if (attempts < 2) retry();
      else fail();
    },
  });
}

export const SidebarDangerConfirmDialog = lazySidebarDialog(() => import("@/components/editor/DangerConfirmDialog.vue"));
export const SidebarVisibleDatabasesDialog = lazySidebarDialog(() => import("@/components/sidebar/VisibleDatabasesDialog.vue"));
export const SidebarVisibleSchemasDialog = lazySidebarDialog(() => import("@/components/sidebar/VisibleSchemasDialog.vue"));
export const SidebarDdlViewDialog = lazySidebarDialog(() => import("@/components/objects/DdlViewDialog.vue"));
export const SidebarObjectSourceDialog = lazySidebarDialog(() => import("@/components/objects/ObjectSourceDialog.vue"));
export const SidebarProcedureExecutionDialog = lazySidebarDialog(() => import("@/components/objects/ProcedureExecutionDialog.vue"));
