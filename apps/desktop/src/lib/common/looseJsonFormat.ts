const CLOSING_BRACKET: Record<string, string> = { "{": "}", "[": "]" };

/** First character of an array's first entry: a value (container, string, number, true/false/null) or `]`. */
const ARRAY_FIRST_ENTRY_START = /^[[{"\-\d\]tfn]$/;

/**
 * Indent text that is shaped like JSON but is not valid JSON, for display only.
 *
 * Serializers such as Fastjson with `WriteClassName` write `1L`, `Set[...]`
 * and similar tokens that strict JSON rejects, so the value cannot be parsed.
 * This formatter does not parse: it re-indents around brackets, commas and
 * colons outside string literals and copies every other character verbatim,
 * so nothing in the value is changed or dropped. The result must never be
 * written back to a database.
 *
 * Returns null unless the text is one bracket-balanced object or array whose
 * first entry starts like JSON (a quoted key for objects), so truncated values
 * and plain text that merely starts with `{` or `[` keep their normal view.
 */
export function formatLooseJsonText(text: string, indent = 2): string | null {
  const source = text.trim();
  if (!looksLikeJsonContainer(source)) return null;

  const unit = " ".repeat(indent);
  const openClosers: string[] = [];
  let output = "";
  const newline = () => {
    output += `\n${unit.repeat(openClosers.length)}`;
  };

  let index = 0;
  while (index < source.length) {
    // Anything after the top-level container closes means this is not one value.
    if (index > 0 && openClosers.length === 0) return null;
    const char = source[index];

    if (char === '"') {
      const end = stringLiteralEnd(source, index);
      if (end < 0) return null;
      output += source.slice(index, end);
      index = end;
    } else if (char === "{" || char === "[") {
      const closer = CLOSING_BRACKET[char];
      const next = nextSignificantIndex(source, index + 1);
      output += char;
      if (source[next] === closer) {
        output += closer;
        index = next + 1;
      } else {
        openClosers.push(closer);
        newline();
        index = next;
      }
    } else if (char === "}" || char === "]") {
      if (openClosers.pop() !== char) return null;
      output = output.trimEnd();
      newline();
      output += char;
      index += 1;
    } else if (char === ",") {
      output += ",";
      newline();
      index = nextSignificantIndex(source, index + 1);
    } else if (char === ":") {
      output += ": ";
      index = nextSignificantIndex(source, index + 1);
    } else {
      if (!isJsonWhitespace(char)) output += char;
      index += 1;
    }
  }
  return openClosers.length === 0 ? output : null;
}

/** Cheap checks that reject plain and truncated text before any formatting work. */
function looksLikeJsonContainer(source: string): boolean {
  const closer = CLOSING_BRACKET[source[0]];
  if (!closer || source[source.length - 1] !== closer) return false;
  const firstEntry = source[nextSignificantIndex(source, 1)];
  return source[0] === "{" ? firstEntry === '"' || firstEntry === "}" : ARRAY_FIRST_ENTRY_START.test(firstEntry);
}

/** Index just past the closing quote of the string literal starting at `start`, or -1 if it is unterminated. */
function stringLiteralEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === '"') return index + 1;
  }
  return -1;
}

function nextSignificantIndex(source: string, start: number): number {
  let index = start;
  while (index < source.length && isJsonWhitespace(source[index])) index += 1;
  return index;
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
