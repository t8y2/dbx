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
 * Returns null unless the text is a bracket-balanced object or array whose
 * first entry starts like JSON (a quoted key for objects), so plain text that
 * merely starts with `{` or `[` keeps its normal view.
 */
export function formatLooseJsonText(text: string, indent = 2): string | null {
  const source = text.trim();
  if (!isLooseJsonContainer(source)) return null;

  const unit = " ".repeat(indent);
  let output = "";
  let depth = 0;
  const newline = () => {
    output += `\n${unit.repeat(depth)}`;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = stringLiteralEnd(source, index);
      output += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === "{" || char === "[") {
      output += char;
      const next = nextSignificantIndex(source, index + 1);
      if (source[next] === (char === "{" ? "}" : "]")) {
        output += source[next];
        index = next + 1;
        continue;
      }
      depth += 1;
      newline();
      index = next;
      continue;
    }
    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      output = output.trimEnd();
      newline();
      output += char;
      index += 1;
      continue;
    }
    if (char === ",") {
      output += ",";
      newline();
      index = nextSignificantIndex(source, index + 1);
      continue;
    }
    if (char === ":") {
      output += ": ";
      index = nextSignificantIndex(source, index + 1);
      continue;
    }
    if (isJsonWhitespace(char)) {
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function isLooseJsonContainer(source: string): boolean {
  const open = source[0];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close || source[source.length - 1] !== close) return false;

  const firstEntry = source[nextSignificantIndex(source, 1)];
  if (open === "{" && firstEntry !== '"' && firstEntry !== "'" && firstEntry !== "}") return false;
  if (open === "[" && !/^[[{"'\-\d\]tfn]$/.test(firstEntry ?? "")) return false;

  // Brackets must balance outside string literals, otherwise the text is a
  // truncated or unrelated value and indentation would only mislead.
  const stack: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = stringLiteralEnd(source, index);
      // An unterminated literal runs to the end, where the closing bracket is not a quote.
      if (source[end - 1] !== char) return false;
      index = end;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if ((char === "}" || char === "]") && stack.pop() !== char) return false;
    index += 1;
    // The top-level container must end at the last character.
    if (stack.length === 0 && index < source.length) return false;
  }
  return stack.length === 0;
}

/** Index just past the closing quote of the literal starting at `start`, or the text length if unterminated. */
function stringLiteralEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function nextSignificantIndex(source: string, start: number): number {
  let index = start;
  while (index < source.length && isJsonWhitespace(source[index])) index += 1;
  return index;
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
