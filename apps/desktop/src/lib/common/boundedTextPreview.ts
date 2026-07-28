export interface BoundedTextPreviewOptions {
  maxCharacters: number;
  maxLines: number;
}

export interface BoundedTextPreview {
  head: string;
  tail: string;
  truncated: boolean;
  omittedCharacters: number;
  omittedLines: number;
  totalCharacters: number;
  totalLines: number;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function clampCodePointEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const current = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff ? end - 1 : end;
}

function clampCodePointStart(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  const previous = text.charCodeAt(start - 1);
  const current = text.charCodeAt(start);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff ? start + 1 : start;
}

function headBoundary(text: string, maxCharacters: number, maxLines: number): number {
  const characterBoundary = Math.min(text.length, maxCharacters);
  let lines = 1;
  for (let index = 0; index < characterBoundary; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > maxLines) return index;
  }
  return clampCodePointEnd(text, characterBoundary);
}

function tailBoundary(text: string, maxCharacters: number, maxLines: number): number {
  const characterBoundary = Math.max(0, text.length - maxCharacters);
  let lines = 1;
  for (let index = text.length - 1; index >= characterBoundary; index -= 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > maxLines) return index + 1;
  }
  return clampCodePointStart(text, characterBoundary);
}

export function createBoundedTextPreview(text: string, options: BoundedTextPreviewOptions): BoundedTextPreview {
  const maxCharacters = Math.max(2, Math.floor(options.maxCharacters));
  const maxLines = Math.max(2, Math.floor(options.maxLines));
  const totalLines = countLines(text);

  if (text.length <= maxCharacters && totalLines <= maxLines) {
    return {
      head: text,
      tail: "",
      truncated: false,
      omittedCharacters: 0,
      omittedLines: 0,
      totalCharacters: text.length,
      totalLines,
    };
  }

  const headEnd = headBoundary(text, Math.ceil(maxCharacters / 2), Math.ceil(maxLines / 2));
  const tailStart = Math.max(headEnd, tailBoundary(text, Math.floor(maxCharacters / 2), Math.floor(maxLines / 2)));
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const visibleLines = countLines(head) + (tail ? countLines(tail) : 0);

  return {
    head,
    tail,
    truncated: true,
    omittedCharacters: tailStart - headEnd,
    omittedLines: Math.max(0, totalLines - visibleLines),
    totalCharacters: text.length,
    totalLines,
  };
}
