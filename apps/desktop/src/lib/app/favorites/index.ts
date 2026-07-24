export { FavoritesController, FAVORITES_STATE_STORAGE_KEY } from "./controller";
export { ensureFavoritesPlaceholdersInTree, ensurePlaceholderForParent, refreshFavoritesPlaceholdersInTree } from "./treeIntegration";
export { decodeDatabaseFromPinKey, decodeFavoritableTypeFromPinKey, migrateFavoritesFromLegacyPinSet, runLegacyFavoritesMigrationIfNeeded, FAVORITES_MIGRATED_KEY, type LegacyFavoritesMigrationResult, type LegacyMigrationRunResult } from "./migration";
