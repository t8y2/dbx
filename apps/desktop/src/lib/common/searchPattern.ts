/**
 * Parse the conventional `/pattern/flags` spelling used by search inputs.
 *
 * This legacy parser intentionally preserves ordinary-search behavior: it
 * accepts the established flag set and adds `i` when the user omits it.
 * Explicit Regex mode uses compileSearchRegex below for runtime-native flags
 * and exact explicit-flag semantics.
 */
export function parseSlashDelimitedRegexQuery(query: string): RegExp | null {
  if (!query.startsWith("/") || query.length < 2) return null;
  const lastSlash = query.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const source = query.slice(1, lastSlash);
  const flags = query.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return null;
  try {
    return new RegExp(source, flags.includes("i") ? flags : `${flags}i`);
  } catch {
    return null;
  }
}

export interface CompiledSearchRegex {
  regex: RegExp | null;
  invalid: boolean;
}

/** Compile a search value when the caller has explicitly enabled Regex mode. */
export function compileSearchRegex(query: string): CompiledSearchRegex {
  const value = query.trim();
  if (!value) return { regex: null, invalid: false };

  // Keep `/pattern/flags` compatible with the existing search syntax.  A
  // slash at the beginning without a closing slash is an ordinary pattern in
  // explicit Regex mode, and therefore goes through the regular constructor.
  if (value.startsWith("/")) {
    const lastSlash = value.lastIndexOf("/");
    if (lastSlash > 0) {
      try {
        return { regex: new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1) || "i"), invalid: false };
      } catch {
        return { regex: null, invalid: true };
      }
    }
  }

  try {
    return { regex: new RegExp(value, "i"), invalid: false };
  } catch {
    return { regex: null, invalid: true };
  }
}
