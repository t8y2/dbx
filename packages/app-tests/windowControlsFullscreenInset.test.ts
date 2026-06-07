import assert from "node:assert/strict";
import test from "node:test";
import * as windowControlsModule from "../../apps/desktop/src/composables/useWindowControls.ts";

test("mac traffic-light inset is removed in fullscreen", () => {
  assert.equal(typeof windowControlsModule.shouldReserveMacTrafficLightInset, "function");
  assert.equal(windowControlsModule.shouldReserveMacTrafficLightInset(true, false), true);
  assert.equal(windowControlsModule.shouldReserveMacTrafficLightInset(true, true), false);
  assert.equal(windowControlsModule.shouldReserveMacTrafficLightInset(false, false), false);
});
