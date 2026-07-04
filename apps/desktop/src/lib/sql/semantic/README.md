# SQL Semantic

This directory owns the pure frontend SQL semantic layer used by editor completion, diagnostics, and navigation.

- `tokens.ts`: span-preserving SQL tokenization and active statement detection.
- `dialect.ts`: dialect adapters for identifier normalization, quoting, qualifier roles, and projection alias visibility.
- `model.ts`: active-statement semantic model, row-source parsing, cursor intent, and confidence/fallback output.
- `completion.ts`: compatibility adapter from semantic intent to the existing SQL completion item builder.
- `references.ts`: shared row-source references for completion, diagnostics, and navigation.
- `diagnostics.ts`: SQL semantic diagnostic helpers and viewport range selection.
- `fixtures.ts` and `types.ts`: test fixtures and shared semantic types.

The older `sqlCompletion.ts` and `sqlNavigation.ts` files remain at `lib/` for now because they are broad public editor utilities. Move them only with a separate behavior-preserving migration.
