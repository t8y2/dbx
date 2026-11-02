import { createApp, h, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { createSqlCompletionAnalysisWorker } from "@/lib/sql/sqlCompletionAnalysisWorker";
import { createSqlDiagnosticAnalysisWorker } from "@/lib/sql/sqlDiagnosticAnalysisWorker";

const pause = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
const report = document.querySelector<HTMLPreElement>("#report")!;
const host = document.querySelector<HTMLDivElement>("#editor")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;

function stats(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: Math.max(...sorted) };
}

button.onclick = async () => {
  button.disabled = true;
  delete report.dataset.complete;
  delete report.dataset.error;
  const results = [];
  try {
    for (const [name, sql] of [
      ["5000 statements", Array.from({ length: 5_000 }, (_, index) => `SELECT ${index} AS value;`).join("\n")],
      ["20000 statements", Array.from({ length: 20_000 }, (_, index) => `SELECT ${index} AS value;`).join("\n")],
      ["5000-line INSERT", `INSERT INTO orders (id, total) VALUES\n${Array.from({ length: 5_000 }, (_, index) => `(${index}, 10),`).join("\n")}\n(5000, 20);`],
    ]) {
      report.textContent = `Running ${name}`;
      const pinia = createPinia();
      setActivePinia(pinia);
      Object.assign(useSettingsStore().editorSettings, { showStatementRunButtons: true, showCurrentStatementFrame: true, showInsertValueHints: true, sqlSemanticDiagnosticsEnabled: true, completionTriggerMode: "positional" });
      const source = ref(sql);
      const app = createApp({
        render: () =>
          h(QueryEditor, {
            modelValue: source.value,
            databaseType: "mysql",
            dialect: "mysql",
            autoFocus: false,
            "onUpdate:modelValue": (value: string) => {
              source.value = value;
            },
          }),
      });
      app.use(pinia);
      app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
      const completion = createSqlCompletionAnalysisWorker();
      const diagnostics = createSqlDiagnosticAnalysisWorker();
      try {
        app.mount(host);
        for (let attempt = 0; attempt < 200 && !host.querySelector(".cm-editor"); attempt++) await pause(50);
        const element = host.querySelector<HTMLElement>(".cm-editor");
        if (!element) throw new Error("Editor did not mount");
        const view = EditorView.findFromDOM(element)!;
        const insideInsert = name.includes("INSERT");
        view.dispatch({ selection: { anchor: view.state.doc.length - (insideInsert ? 2 : 0) }, scrollIntoView: true });
        view.focus();
        await pause(1500);
        const typing: number[] = [];
        const frameGaps: number[] = [];
        let previousFrame = performance.now();
        let frameRequest = 0;
        const frame = (now: number) => {
          frameGaps.push(now - previousFrame);
          previousFrame = now;
          frameRequest = requestAnimationFrame(frame);
        };
        frameRequest = requestAnimationFrame(frame);
        let pendingCompletion = Promise.resolve<unknown>(null);
        let pendingDiagnostics = Promise.resolve<unknown>(null);
        try {
          for (const character of insideInsert ? "123456789012345678901234567890123456789" : "\nSELECT id FROM orders WHERE id = 1;\n") {
            const from = view.state.selection.main.head;
            const start = performance.now();
            view.dispatch({ changes: { from, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" });
            typing.push(performance.now() - start);
            const fullSql = view.state.doc.toString();
            pendingCompletion = completion.analyze({ sql: fullSql, cursor: from + 1, databaseType: "mysql", dialect: "mysql", semanticCompletionEnabled: true });
            pendingDiagnostics = diagnostics.analyze({ sql: fullSql, cursor: from + 1, databaseType: "mysql", visibleRanges: view.visibleRanges });
            await pause(45);
          }
          const analysis = await Promise.all([pendingCompletion, pendingDiagnostics]);
          if (analysis.some((result) => result === null)) throw new Error("Background analysis failed");
          await pause(600);
        } finally {
          cancelAnimationFrame(frameRequest);
        }
        results.push({ name, lines: view.state.doc.lines, characters: view.state.doc.length, typingMs: stats(typing), frameGapMs: stats(frameGaps), samples: typing.length, fullFeatureExtensions: true });
      } finally {
        completion.dispose();
        diagnostics.dispose();
        app.unmount();
      }
    }
    report.textContent = JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2);
    report.dataset.complete = "true";
  } catch (error) {
    report.textContent = String(error);
    report.dataset.error = "true";
  } finally {
    button.disabled = false;
  }
};
