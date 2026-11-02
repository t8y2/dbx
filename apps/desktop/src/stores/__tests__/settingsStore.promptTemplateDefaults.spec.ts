import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveAiChatSelection = vi.fn(async () => {});
const loadAiChatSelection = vi.fn(async () => null);

vi.mock("@/lib/backend/api", () => ({
  loadAiConfigs: vi.fn(async () => []),
  loadAiChatSelection: () => loadAiChatSelection(),
  saveAiChatSelection: (selection: unknown) => saveAiChatSelection(selection),
  loadAiConfig: vi.fn(async () => null),
  loadAiProviderConfigs: vi.fn(async () => null),
  saveAiConfig: vi.fn(async () => {}),
}));

import { useSettingsStore } from "@/stores/settingsStore";

async function flushed(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("settingsStore per-db_type prompt template selection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    saveAiChatSelection.mockClear();
    loadAiChatSelection.mockClear();
    loadAiChatSelection.mockResolvedValue(null);
  });

  it("setDefaultTemplatesForDbType stores the ids and persists them in the chat selection", async () => {
    const settings = useSettingsStore();
    settings.setDefaultTemplatesForDbType("postgresql", ["tpl-1", " tpl-2 ", "tpl-1"]);
    expect(settings.aiDefaultTemplatesByDbType).toEqual({ postgresql: ["tpl-1", "tpl-2"] });
    await flushed();
    expect(saveAiChatSelection).toHaveBeenCalled();
    const payload = saveAiChatSelection.mock.calls.at(-1)?.[0];
    expect(payload.defaultTemplatesByDbType).toEqual({ postgresql: ["tpl-1", "tpl-2"] });
  });

  it("setDefaultTemplatesForDbType with an empty list clears the db_type entry", async () => {
    const settings = useSettingsStore();
    settings.setDefaultTemplatesForDbType("mysql", ["tpl-1"]);
    await flushed();
    saveAiChatSelection.mockClear();
    settings.setDefaultTemplatesForDbType("mysql", []);
    expect(settings.aiDefaultTemplatesByDbType).toEqual({});
    await flushed();
    expect(saveAiChatSelection).toHaveBeenCalled();
    const payload = saveAiChatSelection.mock.calls.at(-1)?.[0];
    // Empty records are omitted entirely, matching the backend's skip_serializing_if.
    expect(payload.defaultTemplatesByDbType).toBeUndefined();
  });

  it("recordLastUsedTemplates skips persisting an empty send for an unrecorded db_type", async () => {
    const settings = useSettingsStore();
    settings.recordLastUsedTemplates("mysql", []);
    expect(settings.aiLastUsedTemplatesByDbType).toEqual({});
    await flushed();
    expect(saveAiChatSelection).not.toHaveBeenCalled();
  });

  it("recordLastUsedTemplates clears the remembered selection when the user sends with no templates", async () => {
    // Regression: a deselected-everything send used to leave the stale entry,
    // resurrecting the old templates the next time a panel opened.
    const settings = useSettingsStore();
    settings.recordLastUsedTemplates("mysql", ["tpl-1"]);
    await flushed();
    saveAiChatSelection.mockClear();

    settings.recordLastUsedTemplates("mysql", []);
    expect(settings.aiLastUsedTemplatesByDbType).toEqual({});
    await flushed();
    expect(saveAiChatSelection).toHaveBeenCalled();
    const payload = saveAiChatSelection.mock.calls.at(-1)?.[0];
    // Empty records are omitted entirely, matching the backend's skip_serializing_if.
    expect(payload.lastUsedTemplatesByDbType).toBeUndefined();
  });

  it("removeTemplateFromDefaultAndLastUsed prunes the id everywhere and drops emptied db_types", async () => {
    const settings = useSettingsStore();
    settings.setDefaultTemplatesForDbType("postgresql", ["tpl-1", "tpl-2"]);
    settings.setDefaultTemplatesForDbType("mysql", ["tpl-1"]);
    settings.recordLastUsedTemplates("sqlite", ["tpl-1"]);
    await flushed();
    saveAiChatSelection.mockClear();

    settings.removeTemplateFromDefaultAndLastUsed("tpl-1");
    expect(settings.aiDefaultTemplatesByDbType).toEqual({ postgresql: ["tpl-2"] });
    expect(settings.aiLastUsedTemplatesByDbType).toEqual({});
    await flushed();
    expect(saveAiChatSelection).toHaveBeenCalled();
  });

  it("removeTemplateFromDefaultAndLastUsed persists nothing for unknown ids", async () => {
    const settings = useSettingsStore();
    settings.setDefaultTemplatesForDbType("postgresql", ["tpl-1"]);
    await flushed();
    saveAiChatSelection.mockClear();

    settings.removeTemplateFromDefaultAndLastUsed("missing");
    expect(settings.aiDefaultTemplatesByDbType).toEqual({ postgresql: ["tpl-1"] });
    await flushed();
    expect(saveAiChatSelection).not.toHaveBeenCalled();
  });

  it("initAiConfigs loads and normalizes both per-db_type records from the saved selection", async () => {
    loadAiChatSelection.mockResolvedValue({
      version: 1,
      effortPreferences: [],
      defaultMode: "ask",
      defaultTemplatesByDbType: { postgresql: ["tpl-1", "  ", "tpl-1"], broken: "not-an-array" },
      lastUsedTemplatesByDbType: { mysql: ["tpl-9"] },
    });
    const settings = useSettingsStore();
    await settings.initAiConfigs();
    expect(settings.aiDefaultTemplatesByDbType).toEqual({ postgresql: ["tpl-1"] });
    expect(settings.aiLastUsedTemplatesByDbType).toEqual({ mysql: ["tpl-9"] });
  });
});
