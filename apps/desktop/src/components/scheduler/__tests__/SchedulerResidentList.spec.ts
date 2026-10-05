// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import SchedulerResidentList from "../SchedulerResidentList.vue";
import type { ResidentSession } from "@/lib/scheduler/schedulerTypes";

const mountedApps: App[] = [];

function session(overrides: Partial<ResidentSession> = {}): ResidentSession {
  return {
    id: "session-1",
    taskId: "task-1",
    runId: "run-1",
    pluginId: "io.dbx.ssh",
    sessionId: "plugin-session-1",
    state: "running",
    heartbeatAt: "2026-10-05T02:00:00Z",
    restartCount: 0,
    createdAt: "2026-10-05T01:00:00Z",
    updatedAt: "2026-10-05T02:00:00Z",
    ...overrides,
  };
}

async function mountList(sessions: ResidentSession[], events: { actions: Array<[string, string]> } = { actions: [] }) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerResidentList, {
    sessions,
    tasks: [{ id: "task-1", name: "生产日志采集" }],
    onAction: (value: ResidentSession, action: string) => events.actions.push([value.sessionId, action]),
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SchedulerResidentList", () => {
  it("renders the frozen resident state vocabulary per session", async () => {
    const container = await mountList([session({ id: "s1", state: "running" }), session({ id: "s2", state: "crashed", restartCount: 3 }), session({ id: "s3", state: "degraded" }), session({ id: "s4", state: "starting" })]);
    expect(container.querySelectorAll("[data-scheduler-resident-row]")).toHaveLength(4);
    expect(container.querySelector("[data-scheduler-resident-row='s1']")?.getAttribute("data-scheduler-resident-state")).toBe("running");
    expect(container.querySelector("[data-scheduler-resident-row='s2']")?.getAttribute("data-scheduler-resident-state")).toBe("crashed");
    expect(container.querySelector("[data-scheduler-resident-row='s3']")?.getAttribute("data-scheduler-resident-state")).toBe("degraded");
    expect(container.textContent).toContain("3");
  });

  it("issues start / stop / restart against the plugin session id", async () => {
    const events = { actions: [] as Array<[string, string]> };
    const container = await mountList([session()], events);
    container.querySelector<HTMLButtonElement>("[data-scheduler-resident-start]")!.click();
    container.querySelector<HTMLButtonElement>("[data-scheduler-resident-stop]")!.click();
    container.querySelector<HTMLButtonElement>("[data-scheduler-resident-restart]")!.click();
    expect(events.actions).toEqual([
      ["plugin-session-1", "start"],
      ["plugin-session-1", "stop"],
      ["plugin-session-1", "restart"],
    ]);
  });

  it("shows the empty hint when no session is active", async () => {
    const container = await mountList([]);
    expect(container.querySelector("[data-scheduler-resident-empty]")).toBeTruthy();
  });
});
