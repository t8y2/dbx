import { describe, expect, it, vi } from "vitest";
import {
  DATA_GRID_CONDITION_TOOLBAR_MIN_WIDTH,
  dataGridToolbarCompactBreakpoint,
  dataGridToolbarIntervalOptions,
  isDataGridToolbarCompact,
  selectDataGridToolbarAutoRefreshInterval,
  selectDataGridToolbarCopyItem,
  selectDataGridToolbarExportItem,
  toggleDataGridToolbarAutoRefresh,
  triggerDataGridToolbarAction,
  triggerDataGridToolbarCopy,
  type DataGridToolbarAutoRefreshCapability,
  type DataGridToolbarCopyCapability,
} from "@/lib/dataGrid/dataGridToolbar";

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
  it("uses a viewport-relative compact breakpoint within stable bounds", () => {
    expect(dataGridToolbarCompactBreakpoint(1920)).toBe(1050);
    expect(dataGridToolbarCompactBreakpoint(1280)).toBe(960);
    expect(dataGridToolbarCompactBreakpoint(1080)).toBe(900);
  });

  it("keeps a scaled 1080p workspace expanded while compacting a narrower pane", () => {
    expect(isDataGridToolbarCompact(1040, 1920)).toBe(true);
    expect(isDataGridToolbarCompact(1040, 1280)).toBe(false);
    expect(isDataGridToolbarCompact(900, 1280)).toBe(true);
    expect(isDataGridToolbarCompact(0, 1280)).toBe(false);
  });

  it("preserves condition input space in embedded data grids", () => {
    expect(dataGridToolbarCompactBreakpoint(1100, DATA_GRID_CONDITION_TOOLBAR_MIN_WIDTH)).toBe(1050);
    expect(isDataGridToolbarCompact(1000, 1100, DATA_GRID_CONDITION_TOOLBAR_MIN_WIDTH)).toBe(true);
    expect(isDataGridToolbarCompact(1000, 1100)).toBe(false);
  });

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

  it("keeps copy format selection available when the current copy action is disabled", async () => {
    const onCopy = vi.fn();
    const onSelect = vi.fn();
    const capability: DataGridToolbarCopyCapability = {
      label: "SQL Updates",
      disabled: true,
      currentValue: "sql-updates",
      items: [
        { value: "tsv", label: "TSV" },
        { value: "sql-updates", label: "SQL Updates", disabled: true },
      ],
      onCopy,
      onSelect,
    };

    await expect(triggerDataGridToolbarCopy(capability)).resolves.toBe(false);
    await expect(selectDataGridToolbarCopyItem(capability, "tsv")).resolves.toBe(true);
    await expect(selectDataGridToolbarCopyItem(capability, "sql-updates")).resolves.toBe(false);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("tsv");
  });
});
