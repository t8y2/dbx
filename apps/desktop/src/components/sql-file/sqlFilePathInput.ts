/**
 * Parse text typed or pasted into the desktop file-path input into a list of
 * file paths. Entries are separated by newlines or ";" (the same separator the
 * input uses to display several selected files). Surrounding whitespace and one
 * pair of wrapping quotes are stripped, since Windows "Copy as path" quotes paths.
 */
export function parseSqlFilePathInput(text: string): string[] {
  return text
    .split(/[\r\n;]+/)
    .map((item) =>
      item
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim(),
    )
    .filter(Boolean);
}
