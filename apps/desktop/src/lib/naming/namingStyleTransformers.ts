import type { NamingStyle } from "./namingStyleDetector";

/**
 * A single identifier: letters, digits, and identifier separator characters.
 * Selections that do not match (spaces, operators, comments, CJK/Cyrillic
 * text, multi-line content) are left untouched instead of being rewritten.
 */
export const SINGLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_$-]+$/;

const LEADING_SEPARATOR_PATTERN = /^[_$-]+/;
const TRAILING_SEPARATOR_PATTERN = /[_$-]+$/;
const SEPARATOR_RUN_PATTERN = /[_$-]+/;

function isLower(letter: string): boolean {
  return letter >= "a" && letter <= "z";
}

function isUpper(letter: string): boolean {
  return letter >= "A" && letter <= "Z";
}

function isDigit(letter: string): boolean {
  return letter >= "0" && letter <= "9";
}

/**
 * Split a separator-free segment on its internal word boundaries: lower→Upper
 * (userName), UPPER→Upper+lower (HTTPServer), and digit→letter (user2Name /
 * sha256Hash). Letter→digit is deliberately NOT a boundary so digit runs stay
 * attached to the preceding word (ipv4, sha256, field1).
 *
 * Implemented as a character scan instead of a zero-width lookbehind regex
 * because lookbehind throws at module-parse time on WebViews older than
 * Safari 16.4 and crashed the whole app there (issue #8202 / #6521 class).
 */
function splitSegmentOnWordBoundaries(segment: string): string[] {
  const words: string[] = [];
  let start = 0;
  for (let index = 1; index < segment.length; index++) {
    const previous = segment[index - 1];
    const current = segment[index];
    const next = segment[index + 1];
    const boundary = (isLower(previous) && isUpper(current)) || (isUpper(previous) && isUpper(current) && isLower(next)) || (isDigit(previous) && (isLower(current) || isUpper(current)));
    if (!boundary) continue;
    words.push(segment.slice(start, index));
    start = index;
  }
  words.push(segment.slice(start));
  return words;
}

interface IdentifierParts {
  leading: string;
  words: string[];
  trailing: string;
}

function splitIntoWords(core: string): IdentifierParts {
  const leadingMatch = LEADING_SEPARATOR_PATTERN.exec(core);
  const leading = leadingMatch ? leadingMatch[0] : "";
  const trailingMatch = TRAILING_SEPARATOR_PATTERN.exec(core);
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const inner = core.slice(leading.length, core.length - trailing.length);
  const words = inner
    .split(SEPARATOR_RUN_PATTERN)
    .flatMap(splitSegmentOnWordBoundaries)
    .filter((word) => word.length > 0);
  return { leading, words, trailing };
}

/**
 * Capitalize a word for camelCase/PascalCase output. Only all-uppercase words
 * (SCREAMING_SNAKE chunks and acronyms) fold their tail to lowercase;
 * mixed-case words keep their body so `user2Name` survives as `User2Name`
 * instead of degrading to `User2name`.
 */
function capitalizeWord(word: string): string {
  if (word.length <= 1) return word.toUpperCase();
  const isAllUppercase = word === word.toUpperCase();
  return word.charAt(0).toUpperCase() + (isAllUppercase ? word.slice(1).toLowerCase() : word.slice(1));
}

/**
 * Convert text to specified naming style.
 *
 * Leading/trailing whitespace and separator runs (`_`, `$`, `-`) are preserved
 * verbatim; only the identifier core is rewritten. Text that is not a single
 * identifier (after trimming whitespace) is returned unchanged.
 */
export function convertToNamingStyle(text: string, targetStyle: NamingStyle): string {
  if (!text) return text;

  const core = text.trim();
  if (!core || !SINGLE_IDENTIFIER_PATTERN.test(core)) return text;

  const whitespaceStart = text.length - text.trimStart().length;
  const leadingWhitespace = text.slice(0, whitespaceStart);
  const trailingWhitespace = text.slice(whitespaceStart + core.length);

  const { leading, words, trailing } = splitIntoWords(core);
  if (words.length === 0) return text;

  let converted: string;
  switch (targetStyle) {
    case "camelCase":
      converted = words.map((word, index) => (index === 0 ? word.toLowerCase() : capitalizeWord(word))).join("");
      break;

    case "PascalCase":
      converted = words.map(capitalizeWord).join("");
      break;

    case "snake_case":
      converted = words.map((word) => word.toLowerCase()).join("_");
      break;

    case "SCREAMING_SNAKE_CASE":
      converted = words.map((word) => word.toUpperCase()).join("_");
      break;

    case "kebab-case":
      converted = words.map((word) => word.toLowerCase()).join("-");
      break;

    default:
      return text;
  }

  return leadingWhitespace + leading + converted + trailing + trailingWhitespace;
}
