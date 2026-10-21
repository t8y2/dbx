// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useObjectDependencies } from "@/composables/useObjectDependencies";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ObjectDependencyTarget } from "@/lib/database/objectDependencyDetails";
import type { QueryResult } from "@/types/database";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), cancelQuery: vi.fn(async () => true), checkConnectionHealth: vi.fn(async () => undefined) }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
const mounted: Array<{ app: App; host: HTMLElement; pinia: Pinia }> = [];
const identity: ObjectDependencyTarget = { connectionId: "original", database: "ORCL", schema: "APP", name: "P", objectType: "PROCEDURE" };
const result = (name = "T"): QueryResult => ({
  columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
  rows: [["DEPENDS_ON", "APP", "P", "PROCEDURE", "OTHER", name, "TABLE", "HARD", null]],
  affected_rows: 0,
  execution_time_ms: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountLoader(enabled = true) {
  const target = ref<ObjectDependencyTarget | undefined>({ ...identity });
  const active = ref(enabled);
  const pinia = createPinia();
  const connections = useConnectionStore(pinia);
  connections.connections = [{ id: "original", name: "original", db_type: "oracle", host: "localhost", port: 1521, username: "test", password: "" }];
  connections.connectedIds.add("original");
  let loader!: ReturnType<typeof useObjectDependencies>;
  const app = createApp(
    defineComponent({
      setup() {
        loader = useObjectDependencies(target, active);
        return () => h("div");
      },
    }),
  );
  app.use(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  mounted.push({ app, host, pinia });
  return { loader, target, active, app };
}
beforeEach(() => {
  vi.clearAllMocks();
  backend.executeQuery.mockReset();
});
afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.app.unmount();
    item.host.remove();
    disposePinia(item.pinia);
  }
});

describe("independent object dependency lifecycle", () => {
  it("loads lazily without a query session and keeps previous rows on refresh failure", async () => {
    backend.executeQuery.mockResolvedValue(result());
    const { loader, active } = mountLoader(false);
    await nextTick();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    active.value = true;
    await vi.waitFor(() => expect(loader.loaded.value).toBe(true));
    expect(backend.executeQuery.mock.calls[0]).toEqual(["original", "ORCL", expect.stringContaining("ALL_DEPENDENCIES"), "APP", expect.stringContaining("object-dependencies-"), { catalog: undefined }]);
    expect(loader.rows.value[0]?.name).toBe("T");
    backend.executeQuery.mockRejectedValueOnce(new Error("permission denied"));
    await loader.refresh();
    expect(loader.error.value).toBe("permission denied");
    expect(loader.rows.value[0]?.name).toBe("T");
    expect(loader.loaded.value).toBe(true);
    backend.executeQuery.mockResolvedValueOnce({ ...result(), rows: [], truncated: true });
    await loader.refresh();
    expect(loader.error.value).toBe("");
    expect(loader.rows.value).toEqual([]);
    expect(loader.truncated.value).toBe(true);
  });

  it("rejects stale refresh responses and cancels only its own execution id", async () => {
    const first = deferred<QueryResult>(),
      second = deferred<QueryResult>();
    backend.executeQuery.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { loader } = mountLoader();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(1));
    const refresh = loader.refresh();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(2));
    expect(backend.cancelQuery).toHaveBeenCalledWith(backend.executeQuery.mock.calls[0]![4]);
    second.resolve(result("CURRENT"));
    await refresh;
    first.resolve(result("OLD"));
    await nextTick();
    expect(loader.rows.value[0]?.name).toBe("CURRENT");
  });

  it("distinguishes A→B→A generations even when the final identity is equal", async () => {
    const a = deferred<QueryResult>(),
      b = deferred<QueryResult>(),
      a2 = deferred<QueryResult>();
    backend.executeQuery.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise);
    const { target, loader } = mountLoader();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(1));
    target.value = { ...identity, name: "B", schema: "OTHER" };
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(2));
    target.value = { ...identity };
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(3));
    a2.resolve(result("CURRENT"));
    await vi.waitFor(() => expect(loader.loaded.value).toBe(true));
    a.resolve(result("OLD_A"));
    b.resolve(result("OLD_B"));
    await nextTick();
    expect(loader.rows.value[0]?.name).toBe("CURRENT");
  });

  it("invalidates close and context changes; a late response cannot refill closed content", async () => {
    const pending = deferred<QueryResult>();
    backend.executeQuery.mockReturnValue(pending.promise);
    const { target, loader } = mountLoader();
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalledTimes(1));
    target.value = undefined;
    pending.resolve(result());
    await nextTick();
    expect(loader.rows.value).toEqual([]);
    expect(loader.loaded.value).toBe(false);
    expect(loader.loading.value).toBe(false);
    expect(backend.cancelQuery).toHaveBeenCalledTimes(1);
  });
});
