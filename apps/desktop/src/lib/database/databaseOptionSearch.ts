export function filterDatabaseOptions(options: string[], query: string, displayName: (option: string) => string = (option) => option): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return options;

  interface RankedOption {
    option: string;
    tier: number;
    index: number;
  }

  const isWordBoundaryMatch = (text: string): boolean => {
    const words = text.split(/[\s_\-(),/]+/);
    return words.some((word) => word.startsWith(normalizedQuery));
  };

  const matches: RankedOption[] = [];

  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const raw = option.toLowerCase();
    const label = displayName(option).toLowerCase();

    let tier = -1;
    if (raw === normalizedQuery || label === normalizedQuery) {
      tier = 0;
    } else if (raw.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) {
      tier = 1;
    } else if (isWordBoundaryMatch(raw) || isWordBoundaryMatch(label)) {
      tier = 2;
    } else if (raw.includes(normalizedQuery) || label.includes(normalizedQuery)) {
      tier = 3;
    }

    if (tier >= 0) {
      matches.push({ option, tier, index });
    }
  }

  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.index - b.index;
  });

  return matches.map((m) => m.option);
}
