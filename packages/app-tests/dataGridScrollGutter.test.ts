import { strict as assert } from "node:assert";
import test from "node:test";
import { dataGridHeaderContentWidth, scrollbarGutterWidth } from "../../apps/desktop/src/lib/dataGridScrollGutter.ts";

test("calculates scrollbar gutter from element dimensions", () => {
  assert.equal(scrollbarGutterWidth({ offsetWidth: 1000, clientWidth: 985 }), 15);
  assert.equal(scrollbarGutterWidth({ offsetWidth: 1000, clientWidth: 1000 }), 0);
});

test("extends header content width by the body scrollbar gutter", () => {
  assert.equal(dataGridHeaderContentWidth("var(--total-w)", 15), "calc(var(--total-w) + 15px)");
  assert.equal(dataGridHeaderContentWidth("var(--total-w)", 0), "var(--total-w)");
});
