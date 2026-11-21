import { beforeEach, describe, expect, it, vi } from "vitest";

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const createShikiSqlHighlighter = vi.fn(async () => (content: string) => `<hl>${content}</hl>`);

vi.mock("@/lib/sql/sqlHighlighter", () => ({
  createShikiSqlHighlighter: (...args: unknown[]) => (createShikiSqlHighlighter as (...a: unknown[]) => unknown)(...args),
  escapeHtml: (content: string) => content.replace(/</g, "&lt;"),
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));

import { useSqlHighlighter } from "@/composables/useSqlHighlighter";

describe("useSqlHighlighter", () => {
  beforeEach(() => createShikiSqlHighlighter.mockClear());

  it("does not load the highlighter until something is highlighted", async () => {
    useSqlHighlighter();
    await flushPromises();
    expect(createShikiSqlHighlighter).not.toHaveBeenCalled();
  });

  it("escapes while loading, then highlights, loading only once", async () => {
    const { highlight } = useSqlHighlighter();
    expect(highlight("a<b")).toBe("a&lt;b");
    expect(highlight("select")).toBe("select");
    await flushPromises();
    expect(createShikiSqlHighlighter).toHaveBeenCalledTimes(1);
    expect(highlight("select")).toBe("<hl>select</hl>");
  });
});
