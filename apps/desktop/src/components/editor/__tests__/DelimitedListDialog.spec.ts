import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DelimitedListDialog.vue", import.meta.url), "utf8");

describe("DelimitedListDialog keyboard submit", () => {
  it("wraps the dialog body in a form whose submit handler confirms", () => {
    expect(source).toContain(`@submit.prevent="confirm"`);
    // The form must enclose the fields and the footer, so Enter in any input submits.
    const formIndex = source.indexOf('<form class="grid gap-4" @submit.prevent="confirm">');
    expect(formIndex).toBeGreaterThan(-1);
    expect(source.indexOf("<DialogHeader>", formIndex)).toBeGreaterThan(formIndex);
    expect(source.indexOf("<DialogFooter>", formIndex)).toBeGreaterThan(formIndex);
    expect(source.indexOf("</form>", formIndex)).toBeGreaterThan(source.indexOf("<DialogFooter>", formIndex));
  });

  it("makes Confirm the only submit button so Enter confirms, not cancel/copy", () => {
    expect(source).toContain('<Button type="submit" :disabled="!preview">');
    // Non-submitting buttons need an explicit type: inside a form, a bare <button> defaults to submit.
    expect(source).toContain('<Button type="button" variant="outline" @click="open = false">');
    expect(source).toContain('<Button type="button" variant="outline" @click="copyPreview" :disabled="!preview">');
  });
});
