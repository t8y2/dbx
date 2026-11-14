import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import { getDefaultExportExecutionMode } from "../exportExecutionMode";

const runtime = vi.hoisted(() => ({ native: true }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtime.native }));

beforeEach(() => {
  setActivePinia(createPinia());
  runtime.native = true;
});

it("reads the current persisted default without opening a dialog", () => {
  const settings = useSettingsStore();
  expect(getDefaultExportExecutionMode()).toBe("immediate");
  settings.updateEditorSettings({ defaultExportMode: "queued" });
  expect(getDefaultExportExecutionMode()).toBe("queued");
  settings.updateEditorSettings({ defaultExportMode: "immediate" });
  expect(getDefaultExportExecutionMode()).toBe("immediate");
});

it("keeps Web exports immediate even when the preference is queued", () => {
  useSettingsStore().updateEditorSettings({ defaultExportMode: "queued" });
  runtime.native = false;
  expect(getDefaultExportExecutionMode()).toBe("immediate");
});
