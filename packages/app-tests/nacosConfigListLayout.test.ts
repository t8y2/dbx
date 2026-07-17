import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY,
  DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS,
  useNacosConfigListColumnResize,
} from "../../apps/desktop/src/composables/useNacosConfigListColumnResize.ts";

function installLocalStorage() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function installDocument() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const listeners = new Map<string, Set<(event: MouseEvent) => void>>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: (type: string, listener: (event: MouseEvent) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: MouseEvent) => void) => {
        listeners.get(type)?.delete(listener);
      },
    },
  });
  return {
    dispatchMouseEvent(type: string, clientX: number) {
      const event = { type, clientX } as MouseEvent;
      listeners.get(type)?.forEach((listener) => listener(event));
    },
    restore() {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

let restoreLocalStorage: (() => void) | undefined;
let documentHarness: ReturnType<typeof installDocument> | undefined;

beforeEach(() => {
  restoreLocalStorage = installLocalStorage();
  documentHarness = installDocument();
});

afterEach(() => {
  documentHarness?.restore();
  documentHarness = undefined;
  restoreLocalStorage?.();
  restoreLocalStorage = undefined;
});

test("Nacos config list keeps overflow tied to the computed width and updates it after drag resizing", () => {
  const layout = useNacosConfigListColumnResize();

  assert.deepEqual(layout.columnWidths.value, [...DEFAULT_NACOS_CONFIG_LIST_COLUMN_WIDTHS]);
  assert.equal(layout.gridTemplateColumns.value, "280px 180px 180px 96px");
  assert.equal(layout.totalWidth.value, 736);
  assert.equal(layout.minWidth.value, "736px");
  assert.equal(layout.totalWidth.value > 700, true);
  assert.equal(layout.totalWidth.value > 820, false);

  let prevented = false;
  layout.onResizeStart(0, {
    clientX: 280,
    preventDefault() {
      prevented = true;
    },
  } as MouseEvent);

  assert.equal(prevented, true);
  assert.equal(layout.resizingColumnIndex.value, 0);

  documentHarness!.dispatchMouseEvent("mousemove", 400);

  assert.deepEqual(layout.columnWidths.value, [400, 180, 180, 96]);
  assert.equal(layout.gridTemplateColumns.value, "400px 180px 180px 96px");
  assert.equal(layout.totalWidth.value, 856);
  assert.equal(layout.minWidth.value, "856px");
  assert.equal(layout.totalWidth.value > 820, true);

  documentHarness!.dispatchMouseEvent("mouseup", 400);

  assert.equal(layout.resizingColumnIndex.value, null);
  assert.equal(localStorage.getItem(NACOS_CONFIG_LIST_COLUMN_WIDTHS_STORAGE_KEY), JSON.stringify([400, 180, 180, 96]));

  const restoredLayout = useNacosConfigListColumnResize();
  assert.deepEqual(restoredLayout.columnWidths.value, [400, 180, 180, 96]);
});
