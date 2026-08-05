import { pinyin } from "pinyin-pro";

const HAN_CHAR = /\p{Script=Han}/u;
const ASCII_ALNUM = /[a-z0-9]/i;
const ASCII_QUERY = /^[a-z0-9]+$/;

/**
 * Highlight ranges (flat [from, to, ...] UTF-16 offsets into `label`) for a
 * completion query, used when CodeMirror's built-in filter is bypassed.
 *
 * Tiers: case-insensitive substring → pinyin initials ("zzj" highlights each
 * Han character of 总租金) → in-order fuzzy. Returns [] when nothing matches.
 */
export function completionMatchRanges(label: string, query: string): number[] {
  if (!query) return [];
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const direct = lowerLabel.indexOf(lowerQuery);
  if (direct >= 0) return [direct, direct + lowerQuery.length];

  if (ASCII_QUERY.test(lowerQuery) && HAN_CHAR.test(label)) {
    const pinyinRanges = pinyinInitialMatchRanges(label, lowerQuery);
    if (pinyinRanges) return pinyinRanges;
  }

  return fuzzyMatchRanges(lowerLabel, lowerQuery);
}

function pinyinInitialMatchRanges(label: string, query: string): number[] | null {
  // Greedy earliest subsequence over the pinyin-initial positions, so both
  // prefix queries ("zz") and skipping queries ("zj") highlight the matched
  // Han characters.
  const ranges: number[] = [];
  let queryIndex = 0;
  let index = 0;
  for (const char of label) {
    if (queryIndex >= query.length) break;
    const isHan = HAN_CHAR.test(char);
    if (isHan || ASCII_ALNUM.test(char)) {
      const initial = isHan ? pinyin(char, { pattern: "first", toneType: "none" }) : char.toLowerCase();
      if (initial === query[queryIndex]) {
        ranges.push(index, index + char.length);
        queryIndex += 1;
      }
    }
    index += char.length;
  }
  return queryIndex === query.length ? ranges : null;
}

function fuzzyMatchRanges(lowerLabel: string, lowerQuery: string): number[] {
  const ranges: number[] = [];
  let from = 0;
  for (const char of lowerQuery) {
    const position = lowerLabel.indexOf(char, from);
    if (position < 0) return [];
    ranges.push(position, position + char.length);
    from = position + char.length;
  }
  return ranges;
}
