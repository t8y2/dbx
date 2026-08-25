import { describe, expect, it } from "vitest";
import capabilitiesJson from "../../../src-tauri/capabilities/default.json?raw";
import mainSource from "./main.ts?raw";
import detachedTabAppSource from "./DetachedTabApp.vue?raw";
import detachedPanelAppSource from "./DetachedPanelApp.vue?raw";
import detachedPanelSource from "./lib/detached/detachedPanel.ts?raw";
import appSource from "./App.vue?raw";
import queryStoreSource from "./stores/queryStore.ts?raw";

describe("detached tab window shell", () => {
  it("routes detached tab URLs to the detached tab shell", () => {
    expect(mainSource).toContain("getDetachedTabModeFromLocation()");
    expect(mainSource).toContain('detachedTabMode ? import("./DetachedTabApp.vue")');
  });

  it("renders the tab with window controls, a dock button, and a unified close button", () => {
    expect(detachedTabAppSource).toContain("<DetachedWindowControls");
    expect(detachedTabAppSource).toContain("t('panelDetach.dock')");
    // dock 按钮保留：显式合并回主窗口，页签不丢。
    expect(detachedTabAppSource.match(/@click="dockToMainWindow"/g)?.length).toBe(1);
    // 标题栏 X 不再绕过确认直删 registry：与系统级关闭统一走 requestCloseWindow（dirty-tab 确认策略）。
    expect(detachedTabAppSource).toContain('@click="requestCloseWindow"');
    expect(detachedTabAppSource).not.toContain("closeWindowDirectly");
    // 确认关闭才移除 registry（Alt+F4/任务栏关闭不再残留 → 下次启动不复活）。
    expect(detachedTabAppSource).toContain("removeDetachedTabEntry(tabId.value)");
  });

  it("routes system-level close requests through the same dirty-tab policy as the titlebar X", () => {
    // Alt+F4/任务栏关闭/macOS 红绿灯：onCloseRequested 拦截后走统一关闭入口（dock 放行）。
    expect(detachedTabAppSource).toContain("await win.onCloseRequested((event) => {");
    expect(detachedTabAppSource).toContain("if (dockRequested) return;");
    expect(detachedTabAppSource).toContain("event.preventDefault();");
    expect(detachedTabAppSource).toContain("requestCloseWindow();");
    // 复用主窗口 dirty-tab 策略：closeTab 触发未保存确认；弹窗提供保存/放弃/取消。
    expect(detachedTabAppSource).toContain("queryStore.closeTab(tabValue.id)");
    expect(detachedTabAppSource).toContain("queryStore.showCloseConfirm");
    expect(detachedTabAppSource).toContain("onCloseConfirmSave");
    expect(detachedTabAppSource).toContain("onCloseConfirmDiscard");
    expect(detachedTabAppSource).toContain("onCloseConfirmCancel");
    // 确认关闭用 destroy（跳过 onCloseRequested 重入）；「保存后关闭」链路完整。
    expect(detachedTabAppSource).toContain("await win.destroy()");
    expect(detachedTabAppSource).toContain("await saveActiveSql({ closeAfterSave: true })");
    expect(detachedTabAppSource).toContain("closeAfterSaveRequested");
  });

  it("reuses the main-window content area and execution composables locally", () => {
    expect(detachedTabAppSource).toContain('from "@/composables/useSqlExecution"');
    expect(detachedTabAppSource).toContain('from "@/composables/useDataGridActions"');
    expect(detachedTabAppSource).toContain("<ContentArea");
    expect(detachedTabAppSource).toContain("<EditorToolbar");
  });

  it("keeps the registry snapshot in sync and docks through the event bus", () => {
    expect(detachedTabAppSource).toContain("updateDetachedTabSnapshot(tabId.value, snapshot)");
    expect(detachedTabAppSource).toContain("requestDockDetachedTab(tabId.value)");
    expect(detachedTabAppSource).toContain('message.action === "detached-tab-assign"');
  });

  it("acknowledges adoption so the main window finalizes only after the child owns the tab", () => {
    // 子窗口 adopt 成功/失败都回执主窗口；关键握手消息用严格发送（失败不吞错）。
    expect(detachedTabAppSource).toContain('action: "detached-tab-adopted"');
    expect(detachedTabAppSource).toContain('action: "detached-tab-adopt-failed"');
    expect(detachedTabAppSource).toContain("sendDetachedPanelMessageOrThrow");
    // adopt 失败（registry 缺失/快照损坏/回执发送失败）自毁窗口，不留空壳。
    expect(detachedTabAppSource.match(/await destroyWindow\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    // 主窗口侧：回执完成/失败分别 resolve/reject 分离调用方的等待。
    expect(appSource).toContain('case "detached-tab-adopted":');
    expect(appSource).toContain("resolveDetachedTabAdoptAck(message.tabId, sourceLabel)");
    expect(appSource).toContain('case "detached-tab-adopt-failed":');
    expect(appSource).toContain('rejectDetachedTabAdoptAck(message.tabId, message.reason ?? "adopt failed", sourceLabel)');
  });

  it("waits for normal panel creation and first-frame readiness before keeping detached state", () => {
    expect(detachedPanelSource).toContain('window.once("tauri://created"');
    expect(detachedPanelSource).toContain("waitForDetachedPanelReady(panel, label)");
    expect(detachedPanelAppSource).toContain('action: "detached-panel-ready"');
    expect(appSource).toContain("resolveDetachedPanelReady(message.panel, sourceLabel)");
  });

  it("transfers DataGrid pending changes with the detach snapshot in both directions", () => {
    // 主窗口 prepare：grid 未保存编辑（newRows/dirtyRows/deletedRows）随快照转移。
    expect(queryStoreSource).toContain("collectDataGridPendingSnapshotsForTab(id)");
    expect(queryStoreSource).toContain("snapshot.dataGridPending = dataGridPending;");
    // 子窗口 adopt 时落本窗口缓存；回同步/dock 前重新收集。
    expect(detachedTabAppSource).toContain("stageDataGridPendingSnapshotsForTab(targetTabId, entry.snapshot.dataGridPending)");
    expect(detachedTabAppSource).toContain("collectDataGridPendingSnapshotsForTab(tabValue.id)");
    // 主窗口 dock 回收与启动恢复同样先落缓存再恢复页签。
    expect(appSource).toContain("stageDataGridPendingSnapshotsForTab(tabId, entry.snapshot.dataGridPending)");
    expect(appSource).toContain("stageDataGridPendingSnapshotsForTab(restored.id, entry.snapshot.dataGridPending)");
  });

  it("restores docked tabs in the main window and closes the child window", () => {
    expect(appSource).toContain("restoreDetachedTabSnapshot(entry.snapshot)");
    expect(appSource).toContain("queryStore.adoptDetachedTab(restored)");
    expect(appSource).toContain("closeDetachedTabWindow(entry.label)");
    expect(appSource).toContain("restoreDetachedTabsOnStartup();");
    expect(appSource).toContain("ensureWarmDetachedTabShell()");
  });

  it("grants window destroy so the docked child window actually closes", () => {
    // dock 流程中主窗口经 closeDetachedTabWindow 关闭子窗口；缺少 core:window:allow-close/
    // allow-destroy 时窗口无法销毁（页签已 dock 但窗口残留）。
    const capabilities = JSON.parse(capabilitiesJson) as { permissions: string[] };
    expect(capabilities.permissions).toContain("core:window:allow-close");
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });

  it("detaches tabs without deleting the shared result cache", () => {
    expect(queryStoreSource).toContain("async function prepareTabDetachSnapshot(id: string)");
    expect(queryStoreSource).toContain("function finalizeTabDetach(id: string)");
    // prepare 写 IndexedDB 结果缓存（不清内存），而不是 closeTab 的 deleteTabResultSnapshot。
    const prepareStart = queryStoreSource.indexOf("async function prepareTabDetachSnapshot(id: string)");
    const finalizeStart = queryStoreSource.indexOf("function finalizeTabDetach(id: string)");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(finalizeStart).toBeGreaterThan(prepareStart);
    const prepareBody = queryStoreSource.slice(prepareStart, finalizeStart);
    expect(prepareBody).toContain("writeTabResultSnapshot(cacheKey, buildTabResultSnapshot(tab), tab.connectionId)");
    expect(prepareBody).not.toContain("deleteTabResultSnapshot");
    expect(prepareBody).not.toContain("clearResultPayload");
    // 快照必须走分离专用序列化：serializeOpenTabs 会对 data 页签剔除 resultCacheKey，
    // 导致子窗口读不回结果（页签显示"需要重新加载"且工具栏按钮缺失）。
    expect(prepareBody).toContain("const snapshot = serializeDetachedTab(tab);");
    const finalizeBody = queryStoreSource.slice(finalizeStart, finalizeStart + 1200);
    expect(finalizeBody).not.toContain("deleteTabResultSnapshot");
    expect(finalizeBody).not.toContain("clearResultRunSnapshots");
  });

  it("never persists open-tabs from detached child windows", () => {
    expect(queryStoreSource).toContain('import { isDetachedChildWindow } from "@/lib/detached/detachedWindowContext"');
    expect(queryStoreSource.match(/isDetachedChildWindow\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("wraps detached shells in TooltipProvider like the main window", () => {
    // DataGrid/EditorToolbar 等使用 shadcn Tooltip（reka-ui），缺少 TooltipProvider 时
    // 子窗口挂载即抛 "Injection Symbol(TooltipProviderContext) not found" 崩溃。
    expect(appSource).toContain('<TooltipProvider :delay-duration="300">');
    expect(detachedTabAppSource).toContain('<TooltipProvider :delay-duration="300">');
    expect(detachedPanelAppSource).toContain('<TooltipProvider :delay-duration="300">');
    // toast 反馈 UI 只在主窗口渲染过；子窗口缺失时错误提示不可见（按钮"点了没反应"）。
    expect(detachedTabAppSource).toContain("toastVisible");
    expect(detachedPanelAppSource).toContain("toastVisible");
  });
});
