import { effectScope, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridAsyncSurface } from "@/composables/useDataGridAsyncSurface";

describe("useDataGridAsyncSurface", () => {
  it("defers mounting until first open and keeps the surface mounted afterward", async () => {
    const open = ref(false);
    const scope = effectScope();
    const mounted = scope.run(() => useDataGridAsyncSurface(open))!;

    expect(mounted.value).toBe(false);

    open.value = true;
    await nextTick();
    expect(mounted.value).toBe(true);

    open.value = false;
    await nextTick();
    expect(mounted.value).toBe(true);

    scope.stop();
  });

  it("mounts immediately when restored with an already-open surface", () => {
    const scope = effectScope();
    const mounted = scope.run(() => useDataGridAsyncSurface(ref(true)))!;

    expect(mounted.value).toBe(true);
    scope.stop();
  });
});
