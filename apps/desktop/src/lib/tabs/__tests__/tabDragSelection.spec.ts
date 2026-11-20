// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { blockTabDragTextSelection, TAB_DRAG_SELECTION_CLASS } from "../tabDragSelection";

const releases: (() => void)[] = [];
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  document.body.innerHTML = "";
});

function selectMessage() {
  const message = document.createElement("p");
  message.textContent = "Table data needs to be reloaded.";
  document.body.appendChild(message);
  const range = document.createRange();
  range.selectNodeContents(message);
  document.getSelection()!.addRange(range);
}

it("clears accidental page selections and blocks new selections until release", () => {
  selectMessage();
  expect(document.getSelection()!.toString()).not.toBe("");
  const release = blockTabDragTextSelection();
  releases.push(release);
  expect(document.getSelection()!.toString()).toBe("");
  const selectionStart = new Event("selectstart", { cancelable: true, bubbles: true });
  document.body.dispatchEvent(selectionStart);
  expect(selectionStart.defaultPrevented).toBe(true);
  selectMessage();
  document.dispatchEvent(new Event("selectionchange"));
  expect(document.getSelection()!.toString()).toBe("");
  release();
  const afterRelease = new Event("selectstart", { cancelable: true, bubbles: true });
  document.body.dispatchEvent(afterRelease);
  expect(afterRelease.defaultPrevented).toBe(false);
  selectMessage();
  document.dispatchEvent(new Event("selectionchange"));
  expect(document.getSelection()!.toString()).not.toBe("");
});

it("keeps overlapping local and remote guards active until both release", () => {
  const local = blockTabDragTextSelection();
  const remote = blockTabDragTextSelection();
  releases.push(local, remote);
  local();
  local();
  expect(document.documentElement.classList.contains(TAB_DRAG_SELECTION_CLASS)).toBe(true);
  remote();
  expect(document.documentElement.classList.contains(TAB_DRAG_SELECTION_CLASS)).toBe(false);
});

it("preserves unrelated inline selection styles and guard classes", () => {
  document.body.style.userSelect = "text";
  document.documentElement.classList.add("dbx-data-grid-native-selection-blocked");
  const release = blockTabDragTextSelection();
  releases.push(release);
  release();
  expect(document.body.style.userSelect).toBe("text");
  expect(document.documentElement.classList.contains("dbx-data-grid-native-selection-blocked")).toBe(true);
  document.body.style.userSelect = "";
  document.documentElement.classList.remove("dbx-data-grid-native-selection-blocked");
});
