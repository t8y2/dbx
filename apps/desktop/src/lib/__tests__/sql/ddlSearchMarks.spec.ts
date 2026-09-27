// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { applyDdlSearchMarks, clearDdlSearchMarks, DDL_SEARCH_MARK_CLASS } from "@/lib/sql/ddlSearchMarks";

let pre: HTMLElement;

function marks(): HTMLElement[] {
  return Array.from(pre.querySelectorAll<HTMLElement>(`mark.${DDL_SEARCH_MARK_CLASS}`));
}

beforeEach(() => {
  pre = document.createElement("pre");
  document.body.replaceChildren(pre);
});

describe("applyDdlSearchMarks", () => {
  it("marks every occurrence, ignoring case", () => {
    pre.innerHTML = "<span>child wo</span><span>CHILD</span>";
    applyDdlSearchMarks(pre, "chiLD");
    expect(marks().map((mark) => mark.textContent)).toEqual(["child", "CHILD"]);
  });

  it("keeps the underlying DDL text unchanged", () => {
    pre.innerHTML = "<span>CREATE TABLE [dbo].[Orders] (</span>";
    const before = pre.textContent;
    applyDdlSearchMarks(pre, "table");
    expect(pre.textContent).toBe(before);
    expect(marks()).toHaveLength(1);
  });

  it("treats the query literally instead of as a regex", () => {
    pre.innerHTML = "<span>SUM(a+b) AND (b+c)</span>";
    applyDdlSearchMarks(pre, "(b+c)");
    expect(marks().map((mark) => mark.textContent)).toEqual(["(b+c)"]);

    applyDdlSearchMarks(pre, "a+b");
    expect(marks().map((mark) => mark.textContent)).toEqual(["a+b"]);
  });

  it("marks matches inside nested elements and next to each other", () => {
    pre.innerHTML = '<span class="hl"><span>name_name</span></span>';
    applyDdlSearchMarks(pre, "name");
    expect(marks().map((mark) => mark.textContent)).toEqual(["name", "name"]);
    expect(pre.textContent).toBe("name_name");
  });

  it("clears the previous marks when the query changes or empties", () => {
    pre.innerHTML = "<span>alpha beta</span>";
    applyDdlSearchMarks(pre, "alpha");
    applyDdlSearchMarks(pre, "beta");
    expect(marks().map((mark) => mark.textContent)).toEqual(["beta"]);

    applyDdlSearchMarks(pre, "");
    expect(marks()).toHaveLength(0);
    expect(pre.textContent).toBe("alpha beta");
  });

  it("does not match across element boundaries", () => {
    pre.innerHTML = "<span>child</span><span>worker</span>";
    applyDdlSearchMarks(pre, "childworker");
    expect(marks()).toHaveLength(0);
  });

  it("ignores missing elements and treats the query literally", () => {
    expect(() => applyDdlSearchMarks(null, "x")).not.toThrow();
    expect(() => clearDdlSearchMarks(undefined)).not.toThrow();

    pre.innerHTML = "<span>[Id] int NOT NULL,</span>";
    applyDdlSearchMarks(pre, "[Id] ");
    expect(marks().map((mark) => mark.textContent)).toEqual(["[Id] "]);
  });
});
