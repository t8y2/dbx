export interface DocumentTextMatch {
  start: number;
  end: number;
}

type JsonTokenRange = DocumentTextMatch & { className: string };

const JSON_TOKEN_PATTERN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function findDocumentTextMatches(text: string, query: string): DocumentTextMatch[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: DocumentTextMatch[] = [];
  let start = 0;

  while (start <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, start);
    if (index < 0) break;
    matches.push({ start: index, end: index + needle.length });
    start = index + Math.max(needle.length, 1);
  }

  return matches;
}

export function renderDocumentJsonHtml(json: string, query = "", activeMatchIndex = 0): string {
  const tokenRanges = jsonTokenRanges(json);
  const searchRanges = findDocumentTextMatches(json, query);
  const boundaries = new Set<number>([0, json.length]);

  for (const range of tokenRanges) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const range of searchRanges) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }

  const points = [...boundaries].sort((left, right) => left - right);
  let tokenIndex = 0;
  let searchIndex = 0;
  let html = "";

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;

    while (tokenRanges[tokenIndex]?.end <= start) tokenIndex += 1;
    while (searchRanges[searchIndex]?.end <= start) searchIndex += 1;

    const token = tokenRanges[tokenIndex];
    const search = searchRanges[searchIndex];
    let segment = escapeHtml(json.slice(start, end));

    if (token && token.start <= start && token.end >= end) {
      segment = `<span class="${token.className}">${segment}</span>`;
    }
    if (search && search.start <= start && search.end >= end) {
      const activeClass = searchIndex === activeMatchIndex ? " document-search-match-active" : "";
      const activeAttribute = searchIndex === activeMatchIndex ? ' data-document-search-active="true"' : "";
      segment = `<mark class="document-search-match${activeClass}" data-document-search-match="${searchIndex}"${activeAttribute}>${segment}</mark>`;
    }

    html += segment;
  }

  return html;
}

function jsonTokenRanges(json: string): JsonTokenRange[] {
  const ranges: JsonTokenRange[] = [];
  const pattern = new RegExp(JSON_TOKEN_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(json))) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      className: jsonTokenClass(match[0]),
    });
  }

  return ranges;
}

function jsonTokenClass(token: string): string {
  if (token.startsWith('"')) return token.endsWith(":") ? "json-key" : "json-string";
  if (token === "true" || token === "false") return "json-boolean";
  if (token === "null") return "json-null";
  return "json-number";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
