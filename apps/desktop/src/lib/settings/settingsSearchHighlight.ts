export function normalizeSettingsSearchText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

// Help icons render inside the title row of a setting, so their trigger button
// must not be mistaken for the setting's own control.
function isSettingsSearchHelpAffordance(element: Element): boolean {
  return element.matches("button.cursor-help");
}

/**
 * Resolves the element that should be highlighted for a settings search result.
 *
 * The search root usually wraps a title row (label + optional help icon) and the
 * control that belongs to the setting. Walking up from the title must stop at
 * the block that owns a control; stopping at the title row only highlights the
 * label, which reads like a rendering glitch.
 */
export function findSettingsSearchHighlightTarget(searchRoot: HTMLElement, title: string): HTMLElement {
  const normalizedTitle = normalizeSettingsSearchText(title);
  const titleElement = Array.from(searchRoot.querySelectorAll<HTMLElement>("label, h3, h4")).find((element) => normalizeSettingsSearchText(element.textContent) === normalizedTitle);
  if (!titleElement) return searchRoot;

  let candidate = titleElement.parentElement;
  while (candidate && candidate !== searchRoot) {
    if (candidate.classList.contains("rounded-md") && candidate.classList.contains("border")) return candidate;
    const settingControls = Array.from(candidate.querySelectorAll<HTMLElement>("input, button, [role='combobox'], textarea")).filter((control) => !isSettingsSearchHelpAffordance(control));
    if (settingControls.length > 0) return candidate;
    candidate = candidate.parentElement;
  }
  return searchRoot;
}
