import { containsHan, orderedSubsequenceSpan, pinyinFirstLetters } from "@/lib/common/pinyin";

/**
 * Scores identifier matches for completion and field pickers.
 * Higher scores are better; -1 means there is no match.
 */
export function identifierMatchScore(candidate: string, query: string): number {
  if (!query) return 1;
  const candidateLower = candidate.toLowerCase();
  const queryLower = query.toLowerCase();

  if (candidateLower === queryLower) return 3000 - candidateLower.length;
  if (candidateLower.startsWith(queryLower)) return 2000 - candidateLower.length;

  const initials = identifierInitials(candidate);
  if (initials && initials.startsWith(queryLower)) {
    const exactInitialsBonus = initials === queryLower ? 400 : 0;
    return 2400 + exactInitialsBonus - candidateLower.length;
  }

  if (/^[a-z0-9]+$/.test(queryLower) && containsHan(candidateLower)) {
    const pinyinInitials = pinyinFirstLetters(candidateLower);
    if (pinyinInitials.startsWith(queryLower)) {
      const exactInitialsBonus = pinyinInitials === queryLower ? 300 : 0;
      return 2300 + exactInitialsBonus - candidateLower.length;
    }
    const subsequence = orderedSubsequenceSpan(pinyinInitials, queryLower);
    if (subsequence) {
      return 1600 - subsequence.first * 30 - (subsequence.span - queryLower.length) * 10 - candidateLower.length;
    }
  }

  const substringIndex = candidateLower.indexOf(queryLower);
  if (substringIndex >= 0) {
    const boundaryBonus = isIdentifierBoundary(candidate, substringIndex) ? 400 : Math.max(0, 180 - substringIndex * 12);
    return 900 + boundaryBonus - candidateLower.length;
  }

  let candidateIndex = 0;
  let totalGap = 0;
  let firstMatchPosition = -1;
  let boundaryBonus = 0;
  for (const character of queryLower) {
    const nextPosition = candidateLower.indexOf(character, candidateIndex);
    if (nextPosition === -1) return -1;
    if (firstMatchPosition === -1) firstMatchPosition = nextPosition;
    if (isIdentifierBoundary(candidate, nextPosition)) boundaryBonus += 40;
    totalGap += nextPosition - candidateIndex;
    candidateIndex = nextPosition + 1;
  }

  const earlyMatchBonus = Math.max(0, 700 - firstMatchPosition * 35) + boundaryBonus;
  if (totalGap >= queryLower.length) {
    return 400 + earlyMatchBonus * 0.3 - totalGap * 20 - candidateLower.length;
  }
  return 1200 + earlyMatchBonus - totalGap * 10 - candidateLower.length;
}

export function matchesIdentifierSearch(candidate: string, query: string): boolean {
  return identifierMatchScore(candidate, query.trim()) >= 0;
}

function identifierWords(candidate: string): string[] {
  return candidate
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function identifierInitials(candidate: string): string {
  return identifierWords(candidate)
    .map((part) => part[0])
    .join("");
}

function isIdentifierBoundary(candidate: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = candidate[index - 1] ?? "";
  const current = candidate[index] ?? "";
  return /[^A-Za-z0-9]/.test(previous) || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(current));
}
