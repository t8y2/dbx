import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridResultLifecycle } from "@/composables/useDataGridResultLifecycle";

describe("useDataGridResultLifecycle", () => {
  it("invalidates operations when the result identity changes", async () => {
    const result = ref<object>({ id: 1 });
    const lifecycle = useDataGridResultLifecycle({ resultKey: result });
    const operation = lifecycle.beginOperation();

    result.value = { id: 2 };
    await nextTick();

    expect(lifecycle.isCurrent(operation)).toBe(false);
    lifecycle.cleanup();
  });

  it("invalidates operations explicitly and cleanup is idempotent", () => {
    const lifecycle = useDataGridResultLifecycle({ resultKey: ref({ id: 1 }) });
    const operation = lifecycle.beginOperation();

    lifecycle.invalidate();
    lifecycle.cleanup();
    lifecycle.cleanup();

    expect(lifecycle.isCurrent(operation)).toBe(false);
  });
});
