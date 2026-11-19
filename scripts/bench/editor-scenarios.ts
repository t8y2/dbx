import { createApp, h, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const pause = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
const host = document.querySelector<HTMLDivElement>("#editor")!;

interface Mounted {
  app: App;
  view: EditorView;
}

let mounted: Mounted[] = [];

function longTasks() {
  const entries: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) entries.push(entry.duration);
  });
  observer.observe({ entryTypes: ["longtask"] });
  return () => {
    observer.disconnect();
    return entries;
  };
}

const api = {
  async mount(sql: string, options: { databaseType?: string; count?: number; at?: "end" | "start" } = {}) {
    const databaseType = options.databaseType ?? "mysql";
    const count = options.count ?? 1;
    const pinia = createPinia();
    setActivePinia(pinia);
    Object.assign(useSettingsStore().editorSettings, { showStatementRunButtons: true, showCurrentStatementFrame: true, showInsertValueHints: true, sqlSemanticDiagnosticsEnabled: true, completionTriggerMode: "positional" });
    const stop = longTasks();
    const startedAt = performance.now();
    for (let index = 0; index < count; index++) {
      const slot = document.createElement("div");
      slot.style.cssText = "height:500px;overflow:hidden";
      host.appendChild(slot);
      const source = ref(sql);
      const app = createApp({
        render: () =>
          h(QueryEditor, {
            modelValue: source.value,
            databaseType,
            dialect: databaseType,
            autoFocus: false,
            "onUpdate:modelValue": (value: string) => {
              source.value = value;
            },
          }),
      });
      app.use(pinia);
      app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
      app.mount(slot);
      for (let attempt = 0; attempt < 400 && !slot.querySelector(".cm-editor"); attempt++) await pause(25);
      const element = slot.querySelector<HTMLElement>(".cm-editor");
      if (!element) throw new Error("Editor did not mount");
      const view = EditorView.findFromDOM(element)!;
      mounted.push({ app, view });
    }
    const mountMs = performance.now() - startedAt;
    await pause(1500);
    const tasks = stop();
    return { mountMs, longTasksMs: tasks, doc: { lines: mounted[0].view.state.doc.lines, length: mounted[0].view.state.doc.length } };
  },
  unmountAll() {
    for (const item of mounted) item.app.unmount();
    mounted = [];
    host.innerHTML = "";
  },
  /** Run `work` and report sync time plus the frame gaps observed until the page settles. */
  async measure(label: string, work: () => void | Promise<void>, settleMs = 800) {
    const stop = longTasks();
    const gaps: number[] = [];
    let previous = performance.now();
    let request = 0;
    const frame = (now: number) => {
      gaps.push(now - previous);
      previous = now;
      request = requestAnimationFrame(frame);
    };
    request = requestAnimationFrame(frame);
    const startedAt = performance.now();
    const result = await work();
    const syncMs = performance.now() - startedAt;
    await pause(settleMs);
    cancelAnimationFrame(request);
    const tasks = stop();
    return { label, result, syncMs, maxFrameGapMs: Math.max(0, ...gaps), longTasksMs: tasks };
  },
  focus(index = 0) {
    mounted[index].view.focus();
  },
  /** Type characters one by one at the caret, through view.dispatch like the real input path. */
  async type(text: string, options: { index?: number; position?: "end" | "middle" | "start"; delayMs?: number } = {}) {
    const view = mounted[options.index ?? 0].view;
    const total = view.state.doc.length;
    const position = options.position === "middle" ? Math.floor(total / 2) : options.position === "start" ? 0 : total;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    view.focus();
    await pause(300);
    const samples: number[] = [];
    for (const character of text) {
      const from = view.state.selection.main.head;
      const startedAt = performance.now();
      view.dispatch({ changes: { from, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      samples.push(performance.now() - startedAt);
      await pause(options.delayMs ?? 45);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
  },
  selectAll(index = 0) {
    const view = mounted[index].view;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  },
  /** Simulate a drag selection: many selection dispatches that grow the range. */
  async dragSelect(fromLine: number, toLine: number, steps = 30, index = 0) {
    const view = mounted[index].view;
    const doc = view.state.doc;
    const anchor = doc.line(Math.min(fromLine, doc.lines)).from;
    for (let step = 1; step <= steps; step++) {
      const line = doc.line(Math.min(doc.lines, Math.round(fromLine + ((toLine - fromLine) * step) / steps)));
      view.dispatch({ selection: { anchor, head: line.to } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  },
  /** Per-step breakdown of a drag selection: synchronous dispatch time versus the frame interval. */
  async dragProfile(fromLine: number, toLine: number, steps = 30, index = 0) {
    const view = mounted[index].view;
    const doc = view.state.doc;
    const anchor = doc.line(Math.min(fromLine, doc.lines)).from;
    view.focus();
    await pause(100);
    const dispatchMs: number[] = [];
    const frameMs: number[] = [];
    let previous = performance.now();
    for (let step = 1; step <= steps; step++) {
      const line = doc.line(Math.min(doc.lines, Math.round(fromLine + ((toLine - fromLine) * step) / steps)));
      const startedAt = performance.now();
      view.dispatch({ selection: { anchor, head: line.to } });
      dispatchMs.push(performance.now() - startedAt);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      frameMs.push(now - previous);
      previous = now;
    }
    const summarize = (values: number[]) => ({ avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length), max: Math.round(Math.max(...values)) });
    return { dispatch: summarize(dispatchMs), frame: summarize(frameMs), runs: view.contentDOM.querySelectorAll("span").length, hasFocus: view.hasFocus };
  },
  /** Type slowly and report every frame gap above 30ms with its offset from the first keystroke. */
  async typeTimeline(text: string, options: { index?: number; position?: "end" | "middle" | "start"; delayMs?: number } = {}) {
    const view = mounted[options.index ?? 0].view;
    const total = view.state.doc.length;
    const position = options.position === "middle" ? Math.floor(total / 2) : options.position === "start" ? 0 : total;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    view.focus();
    await pause(1500);
    const gaps: { at: number; gap: number }[] = [];
    let previous = performance.now();
    let request = 0;
    const origin = performance.now();
    const frame = (now: number) => {
      if (now - previous > 30) gaps.push({ at: Math.round(now - origin), gap: Math.round(now - previous) });
      previous = now;
      request = requestAnimationFrame(frame);
    };
    request = requestAnimationFrame(frame);
    const keystrokes: number[] = [];
    for (const character of text) {
      const from = view.state.selection.main.head;
      view.dispatch({ changes: { from, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" });
      keystrokes.push(Math.round(performance.now() - origin));
      await pause(options.delayMs ?? 45);
    }
    const typedUntil = Math.round(performance.now() - origin);
    await pause(1500);
    cancelAnimationFrame(request);
    return { typedUntil, gaps };
  },
  scrollThrough(index = 0, steps = 40) {
    const view = mounted[index].view;
    const max = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
    return (async () => {
      for (let step = 0; step <= steps; step++) {
        view.scrollDOM.scrollTop = (max * step) / steps;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    })();
  },
  moveCaret(count: number, index = 0) {
    const view = mounted[index].view;
    return (async () => {
      for (let step = 0; step < count; step++) {
        const head = view.state.selection.main.head;
        view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, head + 1) }, userEvent: "select" });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    })();
  },
  pause,
};

Object.assign(window, { bench: api });
document.querySelector<HTMLPreElement>("#report")!.textContent = "ready";
