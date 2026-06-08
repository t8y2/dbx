# SQL Formatter Configuration Design

## Summary

DBX will add a lightweight SQL formatter configuration experience. Users can tune formatter options in a settings window, import and export a small JSON configuration file, and use a capable JSON editor inside that window. The editor shortcuts are part of the configuration window experience only; they are not stored in the SQL formatter configuration file.

## Goals

- Let users customize SQL formatting without replacing the existing `sql-formatter` dependency.
- Keep startup and idle memory low by loading formatter and advanced JSON editor code only when needed.
- Support importing and exporting a dedicated SQL formatter configuration file.
- Provide a comfortable JSON configuration editor in the SQL formatter settings window.
- Make editor shortcuts work consistently on Windows, Linux, and macOS.
- Validate imported configuration before applying it to stored editor settings.

## Non-Goals

- Do not introduce Monaco, Prettier, WASM parsers, or multiple formatter engines.
- Do not turn this into a full editor profile export system.
- Do not store configuration-window shortcuts in the SQL formatter configuration file.
- Do not run SQL formatting automatically while typing.
- Do not implement per-connection formatter profiles in the first version.

## Current Context

The current formatter path is intentionally small:

- `apps/desktop/src/lib/sqlFormatter.ts` imports `format` from `sql-formatter`.
- `formatSqlText(sql, dialect)` maps the DBX dialect to the formatter language.
- The only current formatting option is `keywordCase: "upper"`.
- `QueryEditor.vue` calls `formatSqlText()` only when the user triggers SQL formatting.
- Editor settings already live in `settingsStore.editorSettings` and are persisted through `localStorage`.

This design keeps that structure and adds a typed formatter settings object to the existing editor settings.

## Configuration File

The imported and exported file is a dedicated SQL formatter config:

```json
{
  "version": 1,
  "formatter": "sql-formatter",
  "options": {
    "keywordCase": "upper",
    "functionCase": "preserve",
    "dataTypeCase": "preserve",
    "indentStyle": "spaces",
    "tabWidth": 2,
    "linesBetweenQueries": 1,
    "expressionWidth": 80,
    "semicolonNewline": false
  }
}
```

`version` enables future migrations. `formatter` must be `sql-formatter` in the first version. `options` contains only validated SQL formatter options. Unknown top-level fields are ignored during import. Unknown option fields are rejected with a validation message so users can find mistakes in hand-edited files.

## Stored Settings

Add `sqlFormatter` to `EditorSettings`:

```ts
interface SqlFormatterSettings {
  keywordCase: "upper" | "lower" | "preserve";
  functionCase: "upper" | "lower" | "preserve";
  dataTypeCase: "upper" | "lower" | "preserve";
  indentStyle: "spaces" | "tabs";
  tabWidth: 2 | 4;
  linesBetweenQueries: 0 | 1 | 2;
  expressionWidth: 50 | 80 | 120;
  semicolonNewline: boolean;
}
```

Normalization clamps every field to a known value. Missing fields fall back to defaults. Existing users get the current behavior by default: uppercase keywords and two-space readable formatting.

The exact mapping to `sql-formatter` options should be confirmed against the installed `sql-formatter@15.8.0` type definitions during implementation. Unsupported options are hidden rather than simulated with fragile string rewriting.

## Settings Window

The SQL formatter settings window has two modes:

- Form mode: select controls for common options such as keyword case, indentation, line spacing, and expression width.
- Advanced JSON mode: a JSON editor for the same configuration envelope used by import and export.

Both modes edit the same local draft. Applying settings normalizes and persists the draft. Canceling closes the dialog without touching stored settings.

The window includes:

- Import config
- Export config
- Restore defaults
- Validate
- Apply

Import reads the file once, validates it, updates the local draft, and shows validation errors without applying partial invalid state. Export writes the normalized draft as pretty JSON.

## JSON Editor Shortcuts

The advanced JSON editor should reuse CodeMirror instead of adding a heavier editor. It supports common editing actions with platform-aware shortcuts:

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Undo | `Ctrl+Z` | `Cmd+Z` |
| Redo | `Ctrl+Y`, `Ctrl+Shift+Z` | `Cmd+Shift+Z` |
| Find | `Ctrl+F` | `Cmd+F` |
| Replace | `Ctrl+H` | `Cmd+Alt+F` or an in-window button |
| Select all | `Ctrl+A` | `Cmd+A` |
| Indent more | `Tab` | `Tab` |
| Indent less | `Shift+Tab` | `Shift+Tab` |
| Duplicate current line | `Ctrl+D` | `Cmd+D` |
| Delete current line | `Ctrl+Shift+K` | `Cmd+Shift+K` |
| Move line up/down | `Alt+Up/Down` | `Option+Up/Down` |
| Copy line up/down | `Shift+Alt+Up/Down` | `Shift+Option+Up/Down` |
| Format config JSON | `Shift+Alt+F` | `Shift+Option+F` |
| Apply config | `Ctrl+S` | `Cmd+S` |

Most of these actions come from CodeMirror's existing commands and keymaps. `Duplicate current line` can use `copyLineDown`. `Indent less` can use `indentLess`. The JSON editor uses platform-sensitive display labels, while the command mapping uses CodeMirror's `Mod` abstraction where appropriate.

These shortcuts are local to the SQL formatter configuration window. They do not change the main SQL editor shortcut settings and are not written into exported formatter config files.

## Low-Memory Strategy

- Keep `sql-formatter` as the only SQL formatting engine.
- Lazy-load `sql-formatter` when the user formats SQL or opens the formatter settings preview.
- Lazy-load CodeMirror JSON support only when the user opens Advanced JSON mode.
- Store only a small normalized settings object, not generated formatter state.
- Format only on explicit user action.
- Add a size guard for SQL text. Very large SQL should prompt before formatting or skip formatting with a clear message.
- Avoid background workers in the first version unless formatting proves to block the UI on realistic input.

## Data Flow

1. User opens SQL formatter settings.
2. The window copies `settingsStore.editorSettings.sqlFormatter` into a local draft.
3. Form controls or JSON editor update the draft.
4. Validation normalizes the draft and reports errors.
5. Apply persists the normalized settings through `settingsStore.updateEditorSettings()`.
6. SQL formatting calls `formatSqlText(sql, dialect, sqlFormatterSettings)`.
7. `formatSqlText()` maps DBX settings to `sql-formatter` options and returns formatted SQL.

## Error Handling

- Blank SQL remains unchanged.
- Invalid JSON in Advanced mode shows a local validation error and disables Apply.
- Invalid imported files do not mutate stored settings.
- Unsupported formatter names are rejected.
- Unsupported option values are rejected with field-specific messages.
- Formatter runtime errors keep the existing `formatError` event path and toast behavior.

## Testing

Add focused tests for:

- Default SQL formatter settings preserve current formatting behavior.
- Settings normalization clamps invalid values to defaults.
- Exported config is stable and contains only allowed fields.
- Imported config accepts valid files and rejects invalid files.
- `formatSqlText()` maps settings to formatter options.
- Blank SQL remains unchanged.
- Advanced JSON editor keymap includes `Shift+Tab`, duplicate line, delete line, move line, copy line, and apply shortcuts.

Manual verification should include:

- Windows/Linux shortcut behavior using `Ctrl`.
- macOS shortcut behavior using `Cmd`.
- Import/export round trip.
- No large formatter/editor code loaded before formatting or opening Advanced JSON mode, checked through the built bundle chunks.
