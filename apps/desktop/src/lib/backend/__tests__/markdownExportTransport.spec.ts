// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { exportQueryResultMarkdown } from "@/lib/backend/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("can transpose a selection whose ordinary Markdown request already fills the Web upload limit", async () => {
  const limit = 1024 * 1024;
  const columns = ["value"];
  const rows = Array.from({ length: 1000 }, () => ["x".repeat(1000)]);
  rows[0]![0] += "x".repeat(limit - JSON.stringify({ columns, rows }).length);
  const expectedBody = JSON.stringify({ columns, rows });
  expect(new TextEncoder().encode(expectedBody)).toHaveLength(limit);

  const upload = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (new TextEncoder().encode(String(init?.body)).length > limit) return new Response(null, { status: 413 });
    return Response.json({ content: "| value |\n| --- |\n" });
  });
  vi.stubGlobal("fetch", upload);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:markdown");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  const labels = { field: "字段 & 名称", data: "数据 + #" };
  await exportQueryResultMarkdown("normal.md", columns, rows);
  await exportQueryResultMarkdown("transposed.md", columns, rows, labels);

  expect(upload).toHaveBeenCalledTimes(2);
  const [ordinary, transposed] = upload.mock.calls.map(([input, init]) => {
    expect(init?.method).toBe("POST");
    expect(init?.body === expectedBody).toBe(true);
    return new URL(String(input), "http://localhost");
  });
  expect(ordinary!.pathname).toBe("/api/export/query-result-markdown");
  expect(ordinary!.search).toBe("");
  expect(transposed!.pathname).toBe(ordinary!.pathname);
  expect(Object.fromEntries(transposed!.searchParams)).toEqual(labels);
});
