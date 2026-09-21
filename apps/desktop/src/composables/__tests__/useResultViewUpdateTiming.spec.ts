// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, onMounted, onUpdated, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResultViewUpdateTiming } from "../useResultViewUpdateTiming";

const mounted: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useResultViewUpdateTiming", () => {
  it("measures through the Vue DOM update and replaces the value for a new result", async () => {
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const result = ref({ id: 1 });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          const { elapsedMs } = useResultViewUpdateTiming(
            () => result.value,
            () => true,
            () => "dom",
          );
          onMounted(() => {
            clock = 119;
          });
          onUpdated(() => {
            if (result.value.id === 2 && clock === 130) clock = 147;
          });
          return () => h("div", [h("span", String(result.value.id)), h("output", elapsedMs.value ?? "pending")]);
        },
      }),
    );
    mounted.push(app);
    app.mount(host);
    await nextTick();
    await nextTick();
    expect(host.querySelector("output")?.textContent).toBe("19");

    clock = 130;
    result.value = { id: 2 };
    await nextTick();
    await nextTick();
    await nextTick();
    expect(host.querySelector("span")?.textContent).toBe("2");
    expect(host.querySelector("output")?.textContent).toBe("17");
  });

  it("waits for a successful Canvas draw and rejects draws for stale results", async () => {
    let clock = 10;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const result = ref({ id: 1 });
    const mode = ref<"dom" | "canvas">("canvas");
    let canvasDrawCompleted!: (drawnResult: { id: number }) => void;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          const timing = useResultViewUpdateTiming(
            () => result.value,
            () => true,
            () => mode.value,
          );
          canvasDrawCompleted = timing.canvasDrawCompleted;
          return () => h("output", timing.elapsedMs.value ?? "pending");
        },
      }),
    );
    mounted.push(app);
    app.mount(host);
    await nextTick();
    await nextTick();
    expect(host.textContent).toBe("pending");

    const staleResult = result.value;
    result.value = { id: 2 };
    canvasDrawCompleted(staleResult);
    clock = 20;
    await nextTick();
    await nextTick();
    expect(host.textContent).toBe("pending");
    clock = 35;
    canvasDrawCompleted(result.value);
    await nextTick();
    expect(host.textContent).toBe("15");

    mode.value = "dom";
    await nextTick();
    await nextTick();
    await nextTick();
    expect(host.textContent).toBe("0");
  });

  it("suppresses measurements while disabled", async () => {
    const result = ref({ id: 1 });
    const enabled = ref(false);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          const timing = useResultViewUpdateTiming(
            () => result.value,
            () => enabled.value,
            () => "canvas",
          );
          return () => h("output", timing.elapsedMs.value ?? "pending");
        },
      }),
    );
    mounted.push(app);
    app.mount(host);
    enabled.value = true;
    await nextTick();
    expect(host.textContent).toBe("pending");
    enabled.value = false;
    await nextTick();
    expect(host.textContent).toBe("pending");
  });

  it("does not finish a stale DOM tick after switching to Canvas or after unmount", async () => {
    const result = ref({ id: 1 });
    const mode = ref<"dom" | "canvas">("dom");
    let timing!: ReturnType<typeof useResultViewUpdateTiming<{ id: number }>>;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          timing = useResultViewUpdateTiming(
            () => result.value,
            () => true,
            () => mode.value,
          );
          return () => h("output", timing.elapsedMs.value ?? "pending");
        },
      }),
    );
    mounted.push(app);
    app.mount(host);
    mode.value = "canvas";
    await nextTick();
    await nextTick();
    expect(host.textContent).toBe("pending");

    app.unmount();
    timing.canvasDrawCompleted(result.value);
    expect(timing.elapsedMs.value).toBeUndefined();
  });
});
