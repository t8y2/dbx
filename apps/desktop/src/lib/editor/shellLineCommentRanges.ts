export interface ShellLineCommentRange {
  from: number;
  to: number;
}

/**
 * Finds `//` line comments in shell-style text (the MongoDB editor keeps the SQL grammar for
 * highlighting, so its comments are not tokenized by the parser). Quoted strings and block
 * comments are skipped so markers such as `"https://host"` stay uncommented.
 */
export function shellLineCommentRanges(text: string, to = text.length): ShellLineCommentRange[] {
  const ranges: ShellLineCommentRange[] = [];
  const limit = Math.min(to, text.length);
  let index = 0;

  while (index < limit) {
    const char = text[index];

    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index, char);
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      let end = index + 2;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
      ranges.push({ from: index, to: end });
      index = end;
      continue;
    }

    index += 1;
  }

  return ranges;
}

function skipString(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // Single- and double-quoted strings do not span lines; bail out so an unterminated quote
    // does not swallow the rest of the document.
    if ((quote === '"' || quote === "'") && (char === "\n" || char === "\r")) return index;
    index += 1;
  }
  return index;
}
