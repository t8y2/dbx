import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useMountedOnce } from "@/composables/useMountedOnce";

describe("useMountedOnce", () => {
  it("stays false until the source first turns true, then never resets", async () => {
    const open = ref(false);
    const mounted = useMountedOnce(() => open.value);
    expect(mounted.value).toBe(false);

    open.value = true;
    await nextTick();
    expect(mounted.value).toBe(true);

    open.value = false;
    await nextTick();
    expect(mounted.value).toBe(true);
  });

  it("starts true when the source is already true", () => {
    expect(useMountedOnce(() => true).value).toBe(true);
  });
});
