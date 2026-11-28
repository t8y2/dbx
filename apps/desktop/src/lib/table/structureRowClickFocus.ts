/**
 * Which click targets inside a column row must keep their own focus.
 *
 * `onColumnRowClick` moves focus to the column scroller so the row clipboard
 * shortcuts (Ctrl/Cmd+A, Ctrl/Cmd+C, …) act on the table. That is right for a
 * click on inert cell content, but wrong for a click on a control: focusing the
 * scroller pulls focus out of the control, and reka's popover / dropdown layers
 * dismiss themselves on `focus-outside`. The result was that the type picker,
 * the default-value menu and the comment editor closed in the same tick they
 * opened (#15585), while the length-unit `Select` — a modal layer that ignores
 * focus-outside — kept working.
 */
export const STRUCTURE_ROW_FOCUS_OWNING_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "label",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='combobox']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[aria-haspopup]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function targetAsElement(target: EventTarget | null): Element | null {
  if (!target) return null;
  if (typeof (target as Element).closest === "function") return target as Element;
  const parent = (target as { parentElement?: Element | null }).parentElement ?? null;
  return parent && typeof parent.closest === "function" ? parent : null;
}

/**
 * Finds the nearest matching control inside the clicked table row, ignoring
 * focusable ancestors outside the row (such as the virtual scroll container).
 */
export function structureRowClosestControl(target: EventTarget | null, selector: string): Element | null {
  const element = targetAsElement(target);
  if (!element) return null;
  const row = element.closest("tr");
  const control = element.closest(selector);
  return control && (!row || row.contains(control)) ? control : null;
}

/** True when the click landed on (or inside) a control that owns keyboard focus. */
export function structureRowClickTargetOwnsFocus(target: EventTarget | null): boolean {
  return !!structureRowClosestControl(target, STRUCTURE_ROW_FOCUS_OWNING_CONTROL_SELECTOR);
}
