import { strict as assert } from "node:assert";
import { afterEach, test, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ isTauri: false }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtimeMock.isTauri }));
// saveTextFile.ts is a transitive dependency of aiAnalysisExport.ts; its
// top-level import of isTauriRuntime needs the mock above. The dynamic
// imports (@tauri-apps/*) are never called in these contract tests, but we
// provide no-op mocks in case the module graph ever decides to pre-evaluate
// them.
vi.mock("@tauri-apps/plugin-dialog", () => ({}));
vi.mock("@tauri-apps/plugin-fs", () => ({}));

const { buildAiAnalysisExport } = await import(
  "../../apps/desktop/src/lib/export/aiAnalysisExport.ts"
);

// --- Empty / whitespace-only content ---

test("returns null for empty string content", () => {
  assert.equal(buildAiAnalysisExport({ content: "", analysisLabel: "Analysis", dateLabel: "2026/7/31 10:00:00" }), null);
});

test("returns null for whitespace-only content", () => {
  assert.equal(
    buildAiAnalysisExport({ content: "   \n\t  ", analysisLabel: "Analysis", dateLabel: "2026/7/31 10:00:00" }),
    null,
  );
});

// --- Markdown output format ---

test("builds a 3-line header followed by the content", () => {
  const result = buildAiAnalysisExport({
    connectionName: "MyDB",
    content: "## Summary\n\nThis is the analysis.",
    analysisLabel: "Analysis",
    dateLabel: "2026/7/31 10:00:00",
  });

  assert.ok(result);
  assert.equal(
    result!.markdown,
    "# MyDB · Analysis\n2026/7/31 10:00:00\n## Summary\n\nThis is the analysis.",
  );
});

test("falls back to 'AI' in the header when connection name is missing", () => {
  const result = buildAiAnalysisExport({
    content: "report",
    analysisLabel: "Analysis",
    dateLabel: "2026/7/31 10:00:00",
  });

  assert.ok(result);
  assert.match(result!.markdown, /^# AI · Analysis\n/);
});

test("falls back to 'AI' in the header when connection name is empty string", () => {
  const result = buildAiAnalysisExport({
    connectionName: "",
    content: "report",
    analysisLabel: "Analysis",
    dateLabel: "2026/7/31 10:00:00",
  });

  assert.ok(result);
  assert.match(result!.markdown, /^# AI · Analysis\n/);
});

test("uses the passed connection name in the header line", () => {
  const result = buildAiAnalysisExport({
    connectionName: "production",
    content: "report",
    analysisLabel: "Analysis",
    dateLabel: "2026/7/31 10:00:00",
  });

  assert.ok(result);
  assert.match(result!.markdown, /^# production · Analysis\n/);
});

test("uses the passed analysisLabel and dateLabel", () => {
  const result = buildAiAnalysisExport({
    connectionName: "db",
    content: "report",
    analysisLabel: "智能分析",
    dateLabel: "2026年7月31日 10:00:00",
  });

  assert.ok(result);
  assert.match(result!.markdown, /^# db · 智能分析\n2026年7月31日 10:00:00\n/);
});

// --- Contract: only final analysis content, no reasoning/agentSteps leak ---

test("does not leak reasoning or agentSteps fields into the markdown", () => {
  // Simulate a ChatMessage shape with extra fields — the function only sees
  // the content string, so nothing extra should appear.
  const result = buildAiAnalysisExport({
    connectionName: "safe-db",
    content: "## Result\n\nFinal answer only.",
    analysisLabel: "Analysis",
    dateLabel: "2026/7/31 10:00:00",
  });

  assert.ok(result);
  // The markdown must end with exactly the content — no reasoning sections
  // or agent step artifacts appended.
  assert.ok(result!.markdown.endsWith("Final answer only."));
  assert.equal(result!.markdown.includes("reasoning"), false);
  assert.equal(result!.markdown.includes("agentStep"), false);
  assert.equal(result!.markdown.includes("agentSteps"), false);
});

// --- defaultFileName ---

test("defaultFileName sanitizes connection name", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    const result = buildAiAnalysisExport({
      connectionName: "My/Conn",
      content: "report",
      analysisLabel: "Analysis",
      dateLabel: "2026/7/31 10:00:00",
    });

    assert.ok(result);
    assert.equal(result!.defaultFileName, "My_Conn_260602150405.md");
  } finally {
    vi.useRealTimers();
  }
});

test("defaultFileName strips .sql suffix from connection name", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    const result = buildAiAnalysisExport({
      connectionName: "daily/report.sql",
      content: "report",
      analysisLabel: "Analysis",
      dateLabel: "2026/7/31 10:00:00",
    });

    assert.ok(result);
    assert.equal(result!.defaultFileName, "daily_report_260602150405.md");
  } finally {
    vi.useRealTimers();
  }
});

test("defaultFileName falls back to 'ai' when connection name is missing", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    const result = buildAiAnalysisExport({
      content: "report",
      analysisLabel: "Analysis",
      dateLabel: "2026/7/31 10:00:00",
    });

    assert.ok(result);
    assert.equal(result!.defaultFileName, "ai_260602150405.md");
  } finally {
    vi.useRealTimers();
  }
});

test("defaultFileName falls back to 'ai' when connection name is empty", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    const result = buildAiAnalysisExport({
      connectionName: "",
      content: "report",
      analysisLabel: "Analysis",
      dateLabel: "2026/7/31 10:00:00",
    });

    assert.ok(result);
    assert.equal(result!.defaultFileName, "ai_260602150405.md");
  } finally {
    vi.useRealTimers();
  }
});

test("defaultFileName always ends with .md", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 5, 2, 15, 4, 5));

    const result = buildAiAnalysisExport({
      connectionName: "db",
      content: "report",
      analysisLabel: "Analysis",
      dateLabel: "2026/7/31 10:00:00",
    });

    assert.ok(result);
    assert.ok(result!.defaultFileName.endsWith(".md"));
  } finally {
    vi.useRealTimers();
  }
});
