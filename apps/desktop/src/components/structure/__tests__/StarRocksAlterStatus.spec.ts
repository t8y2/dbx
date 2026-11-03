// @vitest-environment happy-dom
import { createApp, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.query }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({ Button: { template: "<button><slot /></button>" } }));
import Status from "../StarRocksAlterStatus.vue";
let app: App | undefined;
const empty = { columns: ["JobId", "State", "CreateTime"], rows: [] };
const result = (state: string) => ({ ...empty, rows: [["1", state, "2026-01-01"]] });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await nextTick();
};
function mount() {
  const props = reactive({ connectionId: "c", database: "d", tableName: "t", paused: false, revision: 0, dirty: false });
  const busy = vi.fn(),
    completed = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  // Reactive props passed through a small wrapper so target changes update the child.
  app = createApp({ components: { Status }, setup: () => ({ props, busy, completed }), template: '<Status v-bind="props" @busy="busy" @completed="completed" />' });
  app.mount(host);
  return { props, busy, completed, host };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.query.mockReset();
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});
describe("ALTER status polling", () => {
  it("polls active tasks, emits completion once, then stops", async () => {
    let state = "RUNNING";
    mocks.query.mockImplementation((_c, _d, sql) => Promise.resolve(sql.includes(" COLUMN ") ? result(state) : empty));
    const { busy, completed } = mount();
    await flush();
    expect(busy).toHaveBeenLastCalledWith(true);
    state = "FINISHED";
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });
  it("keeps busy evidence on failed polling instead of emitting completion", async () => {
    mocks.query.mockImplementation((_c, _d, sql) => Promise.resolve(sql.includes(" COLUMN ") ? result("RUNNING") : empty));
    const { busy, completed, host } = mount();
    await flush();
    mocks.query.mockRejectedValue(new Error("permission denied"));
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(busy).toHaveBeenLastCalledWith(true);
    expect(completed).not.toHaveBeenCalled();
    expect(host.textContent).toContain("starrocksStatus.queryFailed");
  });
  it("discards responses from the previous table and stops on unmount", async () => {
    const oldResolvers: ((value: unknown) => void)[] = [];
    mocks.query.mockImplementation((_c, _d, sql) =>
      sql.includes("TableName = 't'")
        ? new Promise((resolve) => {
            oldResolvers.push(resolve);
          })
        : Promise.resolve(empty),
    );
    const { props, busy, host } = mount();
    props.tableName = "new";
    await nextTick();
    await flush();
    oldResolvers.forEach((resolve) => resolve(result("RUNNING")));
    await flush();
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(host.textContent).toContain("starrocksStatus.idle");
    app?.unmount();
    app = undefined;
    const calls = mocks.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.query).toHaveBeenCalledTimes(calls);
  });
  it("pauses while saving and probes after submission even without visible jobs", async () => {
    mocks.query.mockResolvedValue(empty);
    const { props } = mount();
    await flush();
    props.paused = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.query).toHaveBeenCalledTimes(3);
    props.revision++;
    props.paused = false;
    await nextTick();
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(mocks.query).toHaveBeenCalledTimes(9);
  });
  it("refreshes a newly finished job after submission even when never observed running", async () => {
    mocks.query.mockResolvedValue(empty);
    const { props, completed } = mount();
    await flush();
    mocks.query.mockImplementation((_c, _d, sql) => Promise.resolve(sql.includes(" COLUMN ") ? result("FINISHED") : empty));
    props.revision++;
    await nextTick();
    await flush();
    expect(completed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.query).toHaveBeenCalledTimes(6);
  });

  it("shows only unfinished jobs and expands the server SQL below the task", async () => {
    mocks.query.mockImplementation((_c, _d, sql) =>
      Promise.resolve(
        sql.includes(" COLUMN ")
          ? {
              columns: ["JobId", "State", "Sql"],
              rows: [
                [1, "RUNNING", "ALTER TABLE t MODIFY COLUMN name varchar(500);"],
                [2, "FINISHED", "old SQL"],
              ],
            }
          : empty,
      ),
    );
    const { host } = mount();
    await flush();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "starrocksStatus.details")!.click();
    await nextTick();
    expect(host.textContent).not.toContain("#2");
    expect(host.querySelector("[data-starrocks-job-sql]")).toBeNull();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("#1"))!.click();
    await nextTick();
    expect(host.querySelector("[data-starrocks-job-sql] pre")?.textContent).toBe("ALTER TABLE t MODIFY COLUMN name varchar(500);");
    expect(host.textContent).not.toContain("old SQL");
  });
  it("explains when the database did not return the original SQL", async () => {
    mocks.query.mockImplementation((_c, _d, sql) => Promise.resolve(sql.includes(" COLUMN ") ? result("RUNNING") : empty));
    const { host } = mount();
    await flush();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "starrocksStatus.details")!.click();
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("#1"))!.click();
    await nextTick();
    expect(host.querySelector("[data-starrocks-job-sql]")?.textContent).toContain("starrocksStatus.sqlUnavailable");
  });
});
