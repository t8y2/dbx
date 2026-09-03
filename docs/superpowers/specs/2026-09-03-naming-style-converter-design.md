# Naming Style Converter Feature Design

**Date:** 2026-09-03  
**Status:** Draft  
**Author:** Claude Code

## Overview

Add intelligent naming style conversion functionality to DBX, enabling users to cycle through multiple naming conventions (camelCase, snake_case, kebab-case, etc.) with a single keyboard shortcut in both editors and input fields.

## Background

DBX currently supports uppercase/lowercase text conversion via `Shift+Alt+U` and `Shift+Alt+L`. Users need a similar convenience for converting between different programming naming conventions, especially when working with:
- Database identifiers (often snake_case)
- JavaScript/TypeScript variables (camelCase)
- Constants (SCREAMING_SNAKE_CASE)
- CSS classes (kebab-case)

## Goals

1. **Smart conversion**: Automatically detect current naming style and cycle to the next style
2. **Universal support**: Work in SQL editors, DDL dialogs, search boxes, and any input field
3. **Non-breaking**: Keep existing uppercase/lowercase shortcuts unchanged
4. **Intuitive**: Require no configuration for common use cases

## Non-Goals

- Visual picker UI for selecting target style (future enhancement)
- Batch conversion of multiple identifiers simultaneously
- Language-specific naming convention enforcement

## Supported Naming Styles

| Style | Example | Use Case |
|-------|---------|----------|
| camelCase | `userName` | JavaScript/Java variables |
| PascalCase | `UserName` | Class names, React components |
| snake_case | `user_name` | Python, Ruby, SQL identifiers |
| SCREAMING_SNAKE_CASE | `USER_NAME` | Constants across languages |
| kebab-case | `user-name` | CSS classes, HTML attributes, URLs |

**Cycle Order:**
```
camelCase → PascalCase → snake_case → SCREAMING_SNAKE_CASE → kebab-case → (loop back)
```

## User Experience

### Keyboard Shortcut

- **Primary**: `Shift+Alt+C` (mnemonic: Convert/Case)
- **Scope**: Works in editors and input fields
- **Behavior**:
  - With selection: converts selected text only
  - Without selection: converts entire input field content
  - In multi-line editors: converts each selected line

### Context Menu

Add new menu item in editor context menu under text transformation section:

```
Convert Selection
  ├─ Uppercase (Shift+Alt+U)          [existing]
  ├─ Lowercase (Shift+Alt+L)          [existing]
  ├─ Toggle Naming Style (Shift+Alt+C) [NEW]
  └─ ...
```

### Visual Feedback

- No toast notification (keeps UI clean)
- Immediate text transformation
- Undo support via `Ctrl+Z`

## Technical Architecture

### Module Structure

```
apps/desktop/src/
├── lib/
│   ├── naming/
│   │   ├── namingStyleDetector.ts       # Detect current style from text
│   │   ├── namingStyleConverter.ts      # Core conversion engine
│   │   └── namingStyleTransformers.ts   # Style-specific transformers
│   └── editor/
│       ├── namingStyleShortcutHandler.ts       # Global shortcut coordination
│       └── queryEditorNamingStyleShortcut.ts   # CodeMirror integration
├── composables/
│   └── useNamingStyleConverter.ts       # Vue composable for components
└── directives/
    └── vNamingStyleSupport.ts           # Directive for input fields
```

### Core APIs

**namingStyleConverter.ts**
```typescript
export type NamingStyle = 
  | "camelCase" 
  | "PascalCase" 
  | "snake_case" 
  | "SCREAMING_SNAKE_CASE" 
  | "kebab-case";

export interface NamingStyleConversionResult {
  text: string;
  style: NamingStyle;
}

export function convertToNextNamingStyle(
  text: string, 
  currentStyle?: NamingStyle
): NamingStyleConversionResult;

export function convertToNamingStyle(
  text: string, 
  targetStyle: NamingStyle
): string;
```

**namingStyleDetector.ts**
```typescript
export function detectNamingStyle(text: string): NamingStyle | null;

// Detection priority:
// 1. Contains hyphens → kebab-case
// 2. Contains underscores + all uppercase → SCREAMING_SNAKE_CASE
// 3. Contains underscores → snake_case
// 4. First letter uppercase → PascalCase
// 5. Default → camelCase
```

**vNamingStyleSupport.ts**
```typescript
// Vue directive usage:
// <input v-naming-style-support />
// <textarea v-naming-style-support />

// Automatically listens for Shift+Alt+C and applies conversion
```

### Integration Points

#### 1. Shortcut Registry

Add new shortcut definition to `shortcutRegistry.ts`:

```typescript
{
  id: "convertNamingStyle",
  labelKey: "settings.shortcutConvertNamingStyle",
  scope: "editor",
  defaultShortcut: "Shift+Alt+C",
}
```

#### 2. QueryEditor Integration

In `QueryEditor.vue`, add keymap binding:

```typescript
...createQueryEditorNamingStyleShortcutBindings(
  shortcuts.convertNamingStyle, 
  () => convertSelectedNamingStyle()
),
```

#### 3. Input Field Support

Add directive to input components:

```vue
<!-- DataGridSearchBar.vue -->
<input
  v-naming-style-support
  v-model="searchText"
  ...
/>

<!-- EditorSearchPanel.vue -->
<input
  ref="searchInputRef"
  v-naming-style-support
  ...
/>

<!-- DDL dialog search (already uses EditorSearchPanel) -->
```

### Data Flow

```
User presses Shift+Alt+C
    ↓
Shortcut handler intercepts
    ↓
Determine context (editor vs input field)
    ↓
Get selected text or entire content
    ↓
detectNamingStyle() identifies current style
    ↓
convertToNextNamingStyle() transforms text
    ↓
Replace selection or content
    ↓
Maintain cursor position/selection range
```

## Algorithm Details

### Style Detection

```typescript
function detectNamingStyle(text: string): NamingStyle | null {
  const trimmed = text.trim();
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) return null;
  
  // Priority order matters
  if (trimmed.includes('-')) return 'kebab-case';
  if (trimmed.includes('_')) {
    return trimmed === trimmed.toUpperCase() 
      ? 'SCREAMING_SNAKE_CASE' 
      : 'snake_case';
  }
  if (/^[A-Z]/.test(trimmed)) return 'PascalCase';
  return 'camelCase';
}
```

### Word Splitting

Handle different delimiters and casing:

```typescript
// user_name → ['user', 'name']
// userName → ['user', 'Name']
// UserName → ['User', 'Name']
// user-name → ['user', 'name']
// USER_NAME → ['USER', 'NAME']
```

Use regex: `/[-_]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/`

### Word Joining

Apply target style rules:

```typescript
// camelCase: first lowercase, rest capitalize
['user', 'name'] → 'userName'

// PascalCase: all capitalize
['user', 'name'] → 'UserName'

// snake_case: all lowercase, join with '_'
['user', 'name'] → 'user_name'

// SCREAMING_SNAKE_CASE: all uppercase, join with '_'
['user', 'name'] → 'USER_NAME'

// kebab-case: all lowercase, join with '-'
['user', 'name'] → 'user-name'
```

## Edge Cases

### Multi-word Identifiers
```
user_name_list → userNameList → UserNameList → user_name_list → USER_NAME_LIST → user-name-list
```

### Numbers
```
user2Name → user_2_name → USER_2_NAME → user-2-name → user2Name → User2Name
```
Insert delimiters around numbers appropriately.

### Special Characters
```
user_name! → userName! → UserName!
```
Preserve non-alphanumeric characters at boundaries.

### Whitespace
- Empty or whitespace-only text: no conversion
- Leading/trailing whitespace: preserve

### Multi-line Selection (Editor Only)
- Convert each line independently
- Preserve line structure
- Empty lines remain empty

### Mixed Styles in Selection
```
user_name and userName → userName and userName (first detected style wins)
```

## Internationalization

Add i18n keys:

**English (en.ts)**
```typescript
editor: {
  contextMenu: {
    convertNamingStyle: "Toggle naming style",
  }
},
settings: {
  shortcutConvertNamingStyle: "Toggle naming style",
}
```

**Chinese (zh-CN.ts)**
```typescript
editor: {
  contextMenu: {
    convertNamingStyle: "切换命名风格",
  }
},
settings: {
  shortcutConvertNamingStyle: "切换命名风格",
}
```

**Portuguese, Korean, Spanish, Italian**: Similar translations

## Testing Strategy

### Unit Tests

**namingStyleDetector.spec.ts**
- Correctly identifies each naming style
- Returns null for non-identifiers
- Handles edge cases (numbers, special chars)

**namingStyleConverter.spec.ts**
- Converts between all style pairs correctly
- Handles multi-word identifiers
- Preserves special characters
- Handles numbers appropriately

**namingStyleTransformers.spec.ts**
- Each transformer produces correct output
- Handles empty input gracefully
- Handles single-word input

### Integration Tests

**QueryEditor integration**
- Shortcut triggers conversion in editor
- Multi-line selection works correctly
- Undo/redo works as expected
- Doesn't interfere with existing shortcuts

**Input field integration**
- Directive registers shortcuts correctly
- Selection vs full-content conversion
- Works across different input types

### E2E Tests

**Editor scenarios**
- Convert SQL column names in query
- Convert JavaScript variable names in function
- Convert identifiers in DDL statements

**Input field scenarios**
- Convert search terms in data grid search
- Convert filter text in DDL dialog search
- Convert text in database search dialog

## Performance Considerations

- **Time complexity**: O(n) where n = text length
- **Regex optimization**: Pre-compile common patterns
- **Large text handling**: Warn if selection > 10,000 characters
- **Debouncing**: Not needed (conversion is on-demand)

## Rollout Plan

### Phase 1: Core Implementation
1. Implement detection and conversion logic
2. Add unit tests
3. Integrate with QueryEditor
4. Add shortcut to registry

### Phase 2: Input Field Support
1. Create Vue directive
2. Apply to search bars
3. Apply to DDL dialogs
4. Add integration tests

### Phase 3: Polish
1. Add context menu item
2. Complete i18n translations
3. Add E2E tests
4. Update documentation

## Future Enhancements

### User Configuration
Allow customization in settings:
- Custom cycle order
- Enable/disable specific styles
- Custom keyboard shortcut

### Additional Styles
- `Title Case` - "User Name"
- `UPPER-KEBAB-CASE` - "USER-NAME"
- `dot.case` - "user.name"

### Smart Context Awareness
- Suggest style based on file type or context
- Learn user preferences over time

### Batch Conversion
- Convert multiple identifiers in selection
- Convert entire file to consistent style

## Security & Privacy

- No data sent to external services
- All conversion happens locally
- No PII concerns (operates on text only)

## Accessibility

- Keyboard-first design (shortcut-driven)
- Works with screen readers (text remains selectable)
- No visual-only indicators
- Undo support for error recovery

## Dependencies

- Existing: CodeMirror, Vue 3, TypeScript
- New: None (pure TypeScript implementation)

## Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Shortcut conflict with user extensions | Low | Medium | Make shortcut configurable |
| Performance on large selections | Low | Low | Add size limit with warning |
| Incorrect style detection | Medium | Low | Comprehensive test coverage |
| Breaking existing uppercase/lowercase | Low | High | Keep existing code untouched |

## Success Metrics

- Feature adoption: % of users who use the shortcut within 30 days
- Usage frequency: Average uses per active user per week
- Error rate: % of undo operations following conversion (should be <5%)
- User feedback: Feature rating in feedback surveys

## Documentation Updates

- Update keyboard shortcuts reference
- Add feature to release notes
- Create tutorial GIF showing the feature
- Update user manual with examples

## Open Questions

None remaining - design is complete.

## Approval

This design requires approval before implementation begins.

**Reviewed by:** [Pending]  
**Approved by:** [Pending]  
**Date:** [Pending]
