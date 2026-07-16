import { describe, expect, it, vi } from "vitest";
import { dataGridToolbarIntervalOptions, selectDataGridToolbarAutoRefreshInterval, selectDataGridToolbarExportItem, toggleDataGridToolbarAutoRefresh, triggerDataGridToolbarAction, type DataGridToolbarAutoRefreshCapability } from "@/lib/dataGrid/dataGridToolbar";

function autoRefreshCapability(overrides: Partial<DataGridToolbarAutoRefreshCapability> = {}): DataGridToolbarAutoRefreshCapability {
  return {
    label: "Auto-refresh",
    shortLabel: "Auto",
    startLabel: "Start auto-refresh",
    stopLabel: "Stop auto-refresh",
    enabled: false,
    intervalSeconds: 10,
    intervalOptions: [5, 10, 30],
    intervalLabel: (seconds) => `${seconds}s`,
    onToggle: vi.fn(),
    onSelectInterval: vi.fn(),
    ...overrides,
  };
}

describe("data grid toolbar capabilities", () => {
  it("does not invoke hidden or disabled actions", async () => {
    const onTrigger = vi.fn();

    await expect(triggerDataGridToolbarAction({ label: "Save", visible: false, onTrigger })).resolves.toBe(false);
    await expect(triggerDataGridToolbarAction({ label: "Save", disabled: true, onTrigger })).resolves.toBe(false);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("invokes enabled save and rollback callbacks independently", async () => {
    const save = vi.fn();
    const rollback = vi.fn();

    await expect(triggerDataGridToolbarAction({ label: "Save", onTrigger: save })).resolves.toBe(true);
    await expect(triggerDataGridToolbarAction({ label: "Rollback", onTrigger: rollback })).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("keeps preset intervals ordered and preserves a persisted custom interval", () => {
    expect(dataGridToolbarIntervalOptions([30, 5, 10, 10, 0, -1, 2.5], 15)).toEqual([5, 10, 15, 30]);
  });

  it("toggles auto-refresh and selects valid intervals", async () => {
    const onToggle = vi.fn();
    const onSelectInterval = vi.fn();
    const capability = autoRefreshCapability({ onToggle, onSelectInterval });

    await expect(toggleDataGridToolbarAutoRefresh(capability)).resolves.toBe(true);
    await expect(selectDataGridToolbarAutoRefreshInterval(capability, 30)).resolves.toBe(true);
    await expect(selectDataGridToolbarAutoRefreshInterval(capability, 99)).resolves.toBe(false);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelectInterval).toHaveBeenCalledOnce();
    expect(onSelectInterval).toHaveBeenCalledWith(30);
  });

  it("blocks auto-refresh changes while the capability is disabled", async () => {
    const onToggle = vi.fn();
    const onSelectInterval = vi.fn();
    const capability = autoRefreshCapability({ disabled: true, onToggle, onSelectInterval });

    await expect(toggleDataGridToolbarAutoRefresh(capability)).resolves.toBe(false);
    await expect(selectDataGridToolbarAutoRefreshInterval(capability, 10)).resolves.toBe(false);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSelectInterval).not.toHaveBeenCalled();
  });

  it("rejects disabled or unknown export items", async () => {
    const onSelect = vi.fn();
    const capability = {
      label: "Export",
      items: [
        { value: "csv", label: "CSV" },
        { value: "sql", label: "SQL", disabled: true },
      ],
      onSelect,
    };

    await expect(selectDataGridToolbarExportItem(capability, "csv")).resolves.toBe(true);
    await expect(selectDataGridToolbarExportItem(capability, "sql")).resolves.toBe(false);
    await expect(selectDataGridToolbarExportItem(capability, "xlsx")).resolves.toBe(false);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("csv");
  });
});
