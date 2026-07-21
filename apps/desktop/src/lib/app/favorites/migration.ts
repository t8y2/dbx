import { emptyFavoritesState, ensureDefaultGroup, isFavoritableTreeNode, sanitizeFavoritesState } from "@/lib/app/favoritesTree";
import type { FavoriteGroup, FavoritesState, TreeNode } from "@/types/database";

const PIN_KEY_V2_PREFIX = ":pin:v2:";

/** Decode the favoritable type (table/view/materialized_view) encoded in a
 *  v2 pin key. Returns `null` if the key is not a v2 pin key or doesn't
 *  decode. */
export function decodeFavoritableTypeFromPinKey(pinId: string): string | null {
  const v2Start = pinId.indexOf(PIN_KEY_V2_PREFIX);
  if (v2Start < 0) return null;
  const encoded = pinId.slice(v2Start + PIN_KEY_V2_PREFIX.length);
  try {
    const decoded = JSON.parse(decodeURIComponent(encoded)) as unknown[];
    const type = decoded[3];
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

/** Returns the database encoded in a v2 pin key, or an empty string when
 *  decoding fails. The first element of the identity tuple is the database. */
export function decodeDatabaseFromPinKey(pinId: string): string {
  const v2Start = pinId.indexOf(PIN_KEY_V2_PREFIX);
  if (v2Start < 0) return "";
  const encoded = pinId.slice(v2Start + PIN_KEY_V2_PREFIX.length);
  try {
    const decoded = JSON.parse(decodeURIComponent(encoded)) as unknown[];
    return typeof decoded[0] === "string" ? decoded[0] : "";
  } catch {
    return "";
  }
}

export interface LegacyFavoritesMigrationResult {
  /** The migrated structured state. Always returns a sanitized state — the
   *  caller is expected to assign it back to the controller. */
  state: FavoritesState;
  /** Pin ids that were not migrated (i.e. were not favoritable or had
   *  undecodable payloads). The caller is expected to persist this set as
   *  the new pin set so favorites no longer appear as pins. */
  remainingPinned: Set<string>;
}

/** Pull existing favorites out of the legacy shared pin set so users don't
 *  lose their work. The old code stored favorites as v2 pin keys, so for
 *  each pin we attempt to decode its type and, if it's a
 *  table/view/materialized_view, mint an equivalent favorite key under the
 *  new `fav:v1` prefix. */
export function migrateFavoritesFromLegacyPinSet(pinned: Set<string>): LegacyFavoritesMigrationResult {
  const state = emptyFavoritesState();
  const remainingPinned = new Set<string>();
  if (!pinned.size) return { state, remainingPinned };
  const seenConnections = new Map<string, FavoriteGroup>();
  let order = 0;
  for (const id of pinned) {
    const type = decodeFavoritableTypeFromPinKey(id);
    if (!type || !isFavoritableTreeNode({ type } as TreeNode)) {
      remainingPinned.add(id);
      continue;
    }
    const v2Start = id.indexOf(PIN_KEY_V2_PREFIX);
    const connectionId = id.slice(0, v2Start);
    const database = decodeDatabaseFromPinKey(id);
    if (!connectionId || !database) {
      remainingPinned.add(id);
      continue;
    }
    let group = seenConnections.get(`${connectionId}::${database}`);
    if (!group) {
      group = ensureDefaultGroup(state, connectionId, database);
      seenConnections.set(`${connectionId}::${database}`, group);
    }
    const favoriteKey = id.replace(PIN_KEY_V2_PREFIX, ":fav:v1:");
    if (!state.items.some((entry) => entry.key === favoriteKey)) {
      state.items.push({ key: favoriteKey, groupId: group.id, note: "", order: order++, createdAt: Date.now() });
    }
  }
  return { state: sanitizeFavoritesState(state), remainingPinned };
}

export const FAVORITES_MIGRATED_KEY = "dbx-favorites-migrated-v1";

export interface LegacyMigrationRunResult {
  /** True if the migration produced a non-empty structured state and the
   *  caller should replace the favorites controller state with it. */
  migrated: boolean;
  /** The new state, when `migrated` is true. */
  state: FavoritesState;
  /** Pin ids that the caller must persist as the new pin set (i.e. legacy
   *  favorites have been removed from the pin set). */
  remainingPinned: Set<string>;
}

/** Run the legacy favorites migration once per client. The marker key
 *  (`FAVORITES_MIGRATED_KEY`) prevents a second pass on subsequent launches.
 *  The migration is skipped if the user already has a favorites state — we
 *  never overwrite fresh edits. */
export function runLegacyFavoritesMigrationIfNeeded(loadLegacyPins: () => Set<string>, existingState: FavoritesState): LegacyMigrationRunResult {
  if (typeof localStorage === "undefined") return { migrated: false, state: existingState, remainingPinned: new Set() };
  if (localStorage.getItem(FAVORITES_MIGRATED_KEY) === "1") return { migrated: false, state: existingState, remainingPinned: new Set() };
  if (localStorage.getItem("dbx-favorites-state") !== null) {
    localStorage.setItem(FAVORITES_MIGRATED_KEY, "1");
    return { migrated: false, state: existingState, remainingPinned: new Set() };
  }
  const legacyPinned = loadLegacyPins();
  if (!legacyPinned.size) {
    localStorage.setItem(FAVORITES_MIGRATED_KEY, "1");
    return { migrated: false, state: existingState, remainingPinned: new Set() };
  }
  const result = migrateFavoritesFromLegacyPinSet(legacyPinned);
  if (result.state.items.length > 0) {
    localStorage.setItem(FAVORITES_MIGRATED_KEY, "1");
    return { migrated: true, state: result.state, remainingPinned: result.remainingPinned };
  }
  localStorage.setItem(FAVORITES_MIGRATED_KEY, "1");
  return { migrated: false, state: existingState, remainingPinned: result.remainingPinned };
}
