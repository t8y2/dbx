# Naming Style Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add intelligent naming style conversion to DBX that cycles between camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE, and kebab-case via keyboard shortcut.

**Architecture:** Core conversion engine with style detection + transformers, integrated into CodeMirror editors via shortcut bindings and into input fields via Vue directive.

**Tech Stack:** TypeScript, Vue 3, CodeMirror, Vitest

## Global Constraints

- TypeScript strict mode enabled
- Follow existing DBX code style and patterns
- Test files go in `__tests__` directories adjacent to implementation
- Use Vitest with `// @vitest-environment happy-dom` for DOM tests
- Run tests with `npm test` (uses `vitest run`)
- Keep existing uppercase/lowercase shortcuts (Shift+Alt+U/L) unchanged
- New shortcut: Shift+Alt+C for naming style conversion

---

## Task 1: Core Naming Style Types and Detection

**Files:**
- Create: `apps/desktop/src/lib/naming/namingStyleDetector.ts`
- Create: `apps/desktop/src/lib/naming/__tests__/namingStyleDetector.spec.ts`

**Interfaces:**
- Consumes: None (foundation)
- Produces: 
  - `type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "SCREAMING_SNAKE_CASE" | "kebab-case"`
  - `function detectNamingStyle(text: string): NamingStyle | null`

- [ ] **Step 1: Write failing test for basic style detection**

```typescript
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { detectNamingStyle } from "../namingStyleDetector";

describe("detectNamingStyle", () => {
  it("detects camelCase", () => {
    expect(detectNamingStyle("userName")).toBe("camelCase");
    expect(detectNamingStyle("userNameList")).toBe("camelCase");
  });

  it("detects PascalCase", () => {
    expect(detectNamingStyle("UserName")).toBe("PascalCase");
    expect(detectNamingStyle("UserNameList")).toBe("PascalCase");
  });

  it("detects snake_case", () => {
    expect(detectNamingStyle("user_name")).toBe("snake_case");
    expect(detectNamingStyle("user_name_list")).toBe("snake_case");
  });

  it("detects SCREAMING_SNAKE_CASE", () => {
    expect(detectNamingStyle("USER_NAME")).toBe("SCREAMING_SNAKE_CASE");
    expect(detectNamingStyle("USER_NAME_LIST")).toBe("SCREAMING_SNAKE_CASE");
  });

  it("detects kebab-case", () => {
    expect(detectNamingStyle("user-name")).toBe("kebab-case");
    expect(detectNamingStyle("user-name-list")).toBe("kebab-case");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test namingStyleDetector.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement basic detection logic**

```typescript
export type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "SCREAMING_SNAKE_CASE" | "kebab-case";

export function detectNamingStyle(text: string): NamingStyle | null {
  const trimmed = text.trim();
  
  // Empty or no letters
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) {
    return null;
  }
  
  // Priority order matters for accurate detection
  if (trimmed.includes("-")) {
    return "kebab-case";
  }
  
  if (trimmed.includes("_")) {
    // Check if all letters are uppercase
    const lettersOnly = trimmed.replace(/[^a-zA-Z]/g, "");
    return lettersOnly === lettersOnly.toUpperCase() ? "SCREAMING_SNAKE_CASE" : "snake_case";
  }
  
  // Check first character for Pascal vs camel
  if (/^[A-Z]/.test(trimmed)) {
    return "PascalCase";
  }
  
  return "camelCase";
}
```

- [ ] **Step 4: Run test to verify basic detection passes**

Run: `npm test namingStyleDetector.spec.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for edge cases**

```typescript
describe("detectNamingStyle edge cases", () => {
  it("returns null for empty string", () => {
    expect(detectNamingStyle("")).toBe(null);
    expect(detectNamingStyle("   ")).toBe(null);
  });

  it("returns null for non-identifier strings", () => {
    expect(detectNamingStyle("123")).toBe(null);
    expect(detectNamingStyle("!!!")).toBe(null);
  });

  it("handles numbers in identifiers", () => {
    expect(detectNamingStyle("user2Name")).toBe("camelCase");
    expect(detectNamingStyle("User2Name")).toBe("PascalCase");
    expect(detectNamingStyle("user_2_name")).toBe("snake_case");
    expect(detectNamingStyle("USER_2_NAME")).toBe("SCREAMING_SNAKE_CASE");
    expect(detectNamingStyle("user-2-name")).toBe("kebab-case");
  });

  it("handles special characters at boundaries", () => {
    expect(detectNamingStyle("userName!")).toBe("camelCase");
    expect(detectNamingStyle("user_name@")).toBe("snake_case");
  });

  it("prioritizes kebab-case over mixed styles", () => {
    expect(detectNamingStyle("user-name_test")).toBe("kebab-case");
  });

  it("prioritizes underscores over camelCase when both present", () => {
    expect(detectNamingStyle("user_Name")).toBe("snake_case");
  });
});
```

- [ ] **Step 6: Run test to verify edge case tests fail where needed**

Run: `npm test namingStyleDetector.spec.ts`
Expected: Most edge cases should already pass, verify behavior is correct

- [ ] **Step 7: Commit detection implementation**

```bash
git add apps/desktop/src/lib/naming/namingStyleDetector.ts
git add apps/desktop/src/lib/naming/__tests__/namingStyleDetector.spec.ts
git commit -m "feat: add naming style detection"
```

---

## Task 2: Word Splitting and Transformation Logic

**Files:**
- Create: `apps/desktop/src/lib/naming/namingStyleTransformers.ts`
- Create: `apps/desktop/src/lib/naming/__tests__/namingStyleTransformers.spec.ts`

**Interfaces:**
- Consumes: `type NamingStyle` from namingStyleDetector.ts
- Produces:
  - `function splitWords(text: string): string[]`
  - `function toCamelCase(words: string[]): string`
  - `function toPascalCase(words: string[]): string`
  - `function toSnakeCase(words: string[]): string`
  - `function toScreamingSnakeCase(words: string[]): string`
  - `function toKebabCase(words: string[]): string`

- [ ] **Step 1: Write failing test for word splitting**

```typescript
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { splitWords } from "../namingStyleTransformers";

describe("splitWords", () => {
  it("splits snake_case", () => {
    expect(splitWords("user_name")).toEqual(["user", "name"]);
    expect(splitWords("user_name_list")).toEqual(["user", "name", "list"]);
  });

  it("splits SCREAMING_SNAKE_CASE", () => {
    expect(splitWords("USER_NAME")).toEqual(["USER", "NAME"]);
    expect(splitWords("USER_NAME_LIST")).toEqual(["USER", "NAME", "LIST"]);
  });

  it("splits kebab-case", () => {
    expect(splitWords("user-name")).toEqual(["user", "name"]);
    expect(splitWords("user-name-list")).toEqual(["user", "name", "list"]);
  });

  it("splits camelCase", () => {
    expect(splitWords("userName")).toEqual(["user", "Name"]);
    expect(splitWords("userNameList")).toEqual(["user", "Name", "List"]);
  });

  it("splits PascalCase", () => {
    expect(splitWords("UserName")).toEqual(["User", "Name"]);
    expect(splitWords("UserNameList")).toEqual(["User", "Name", "List"]);
  });

  it("handles numbers", () => {
    expect(splitWords("user2Name")).toEqual(["user", "2", "Name"]);
    expect(splitWords("user_2_name")).toEqual(["user", "2", "name"]);
  });

  it("handles consecutive uppercase letters", () => {
    expect(splitWords("XMLParser")).toEqual(["XML", "Parser"]);
    expect(splitWords("parseXML")).toEqual(["parse", "XML"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test namingStyleTransformers.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement word splitting**

```typescript
import type { NamingStyle } from "./namingStyleDetector";

export function splitWords(text: string): string[] {
  // Replace delimiters with spaces, then split on case boundaries
  const withSpaces = text
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  
  return withSpaces.split(/\s+/).filter((word) => word.length > 0);
}
```

- [ ] **Step 4: Run test to verify splitting passes**

Run: `npm test namingStyleTransformers.spec.ts`
Expected: PASS for splitWords tests

- [ ] **Step 5: Write failing tests for transformers**

```typescript
import { toCamelCase, toPascalCase, toSnakeCase, toScreamingSnakeCase, toKebabCase } from "../namingStyleTransformers";

describe("toCamelCase", () => {
  it("converts words to camelCase", () => {
    expect(toCamelCase(["user", "name"])).toBe("userName");
    expect(toCamelCase(["user", "name", "list"])).toBe("userNameList");
  });

  it("handles single word", () => {
    expect(toCamelCase(["user"])).toBe("user");
  });

  it("handles numbers", () => {
    expect(toCamelCase(["user", "2", "name"])).toBe("user2Name");
  });

  it("normalizes case", () => {
    expect(toCamelCase(["USER", "NAME"])).toBe("userName");
  });
});

describe("toPascalCase", () => {
  it("converts words to PascalCase", () => {
    expect(toPascalCase(["user", "name"])).toBe("UserName");
    expect(toPascalCase(["user", "name", "list"])).toBe("UserNameList");
  });

  it("handles single word", () => {
    expect(toPascalCase(["user"])).toBe("User");
  });
});

describe("toSnakeCase", () => {
  it("converts words to snake_case", () => {
    expect(toSnakeCase(["user", "name"])).toBe("user_name");
    expect(toSnakeCase(["user", "name", "list"])).toBe("user_name_list");
  });

  it("handles mixed case input", () => {
    expect(toSnakeCase(["User", "Name"])).toBe("user_name");
  });
});

describe("toScreamingSnakeCase", () => {
  it("converts words to SCREAMING_SNAKE_CASE", () => {
    expect(toScreamingSnakeCase(["user", "name"])).toBe("USER_NAME");
    expect(toScreamingSnakeCase(["user", "name", "list"])).toBe("USER_NAME_LIST");
  });
});

describe("toKebabCase", () => {
  it("converts words to kebab-case", () => {
    expect(toKebabCase(["user", "name"])).toBe("user-name");
    expect(toKebabCase(["user", "name", "list"])).toBe("user-name-list");
  });
});
```

- [ ] **Step 6: Run test to verify transformer tests fail**

Run: `npm test namingStyleTransformers.spec.ts`
Expected: FAIL for transformer functions

- [ ] **Step 7: Implement transformers**

```typescript
function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function toCamelCase(words: string[]): string {
  if (words.length === 0) return "";
  const normalized = words.map((w) => w.toLowerCase());
  return normalized[0] + normalized.slice(1).map(capitalize).join("");
}

export function toPascalCase(words: string[]): string {
  return words.map(capitalize).join("");
}

export function toSnakeCase(words: string[]): string {
  return words.map((w) => w.toLowerCase()).join("_");
}

export function toScreamingSnakeCase(words: string[]): string {
  return words.map((w) => w.toUpperCase()).join("_");
}

export function toKebabCase(words: string[]): string {
  return words.map((w) => w.toLowerCase()).join("-");
}
```

- [ ] **Step 8: Run test to verify transformers pass**

Run: `npm test namingStyleTransformers.spec.ts`
Expected: PASS

- [ ] **Step 9: Commit transformer implementation**

```bash
git add apps/desktop/src/lib/naming/namingStyleTransformers.ts
git add apps/desktop/src/lib/naming/__tests__/namingStyleTransformers.spec.ts
git commit -m "feat: add naming style word splitting and transformers"
```

---

## Task 3: Core Conversion Engine

**Files:**
- Create: `apps/desktop/src/lib/naming/namingStyleConverter.ts`
- Create: `apps/desktop/src/lib/naming/__tests__/namingStyleConverter.spec.ts`

**Interfaces:**
- Consumes:
  - `type NamingStyle`, `detectNamingStyle()` from namingStyleDetector.ts
  - `splitWords()`, `toCamelCase()`, `toPascalCase()`, `toSnakeCase()`, `toScreamingSnakeCase()`, `toKebabCase()` from namingStyleTransformers.ts
- Produces:
  - `interface NamingStyleConversionResult { text: string; style: NamingStyle }`
  - `function convertToNextNamingStyle(text: string, currentStyle?: NamingStyle): NamingStyleConversionResult`
  - `function convertToNamingStyle(text: string, targetStyle: NamingStyle): string`

- [ ] **Step 1: Write failing test for conversion cycle**

```typescript
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { convertToNextNamingStyle, convertToNamingStyle } from "../namingStyleConverter";

describe("convertToNextNamingStyle", () => {
  it("cycles through naming styles in order", () => {
    // Start with camelCase
    let result = convertToNextNamingStyle("userName");
    expect(result.text).toBe("UserName");
    expect(result.style).toBe("PascalCase");

    // PascalCase → snake_case
    result = convertToNextNamingStyle(result.text);
    expect(result.text).toBe("user_name");
    expect(result.style).toBe("snake_case");

    // snake_case → SCREAMING_SNAKE_CASE
    result = convertToNextNamingStyle(result.text);
    expect(result.text).toBe("USER_NAME");
    expect(result.style).toBe("SCREAMING_SNAKE_CASE");

    // SCREAMING_SNAKE_CASE → kebab-case
    result = convertToNextNamingStyle(result.text);
    expect(result.text).toBe("user-name");
    expect(result.style).toBe("kebab-case");

    // kebab-case → camelCase (loop back)
    result = convertToNextNamingStyle(result.text);
    expect(result.text).toBe("userName");
    expect(result.style).toBe("camelCase");
  });

  it("handles explicit currentStyle parameter", () => {
    const result = convertToNextNamingStyle("user_name", "snake_case");
    expect(result.text).toBe("USER_NAME");
    expect(result.style).toBe("SCREAMING_SNAKE_CASE");
  });

  it("preserves special characters at boundaries", () => {
    const result = convertToNextNamingStyle("userName!");
    expect(result.text).toBe("UserName!");
  });

  it("handles multi-word identifiers", () => {
    const result = convertToNextNamingStyle("userNameList");
    expect(result.text).toBe("UserNameList");
    expect(result.style).toBe("PascalCase");
  });

  it("returns original text unchanged for non-identifiers", () => {
    const result = convertToNextNamingStyle("123");
    expect(result.text).toBe("123");
    expect(result.style).toBe("camelCase");
  });
});

describe("convertToNamingStyle", () => {
  it("converts to specific target style", () => {
    expect(convertToNamingStyle("userName", "PascalCase")).toBe("UserName");
    expect(convertToNamingStyle("userName", "snake_case")).toBe("user_name");
    expect(convertToNamingStyle("userName", "SCREAMING_SNAKE_CASE")).toBe("USER_NAME");
    expect(convertToNamingStyle("userName", "kebab-case")).toBe("user-name");
    expect(convertToNamingStyle("userName", "camelCase")).toBe("userName");
  });

  it("works from any source style", () => {
    expect(convertToNamingStyle("user_name", "camelCase")).toBe("userName");
    expect(convertToNamingStyle("USER_NAME", "kebab-case")).toBe("user-name");
    expect(convertToNamingStyle("user-name", "PascalCase")).toBe("UserName");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test namingStyleConverter.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement conversion engine**

```typescript
import { detectNamingStyle, type NamingStyle } from "./namingStyleDetector";
import {
  splitWords,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  toScreamingSnakeCase,
  toKebabCase,
} from "./namingStyleTransformers";

export interface NamingStyleConversionResult {
  text: string;
  style: NamingStyle;
}

const STYLE_CYCLE: NamingStyle[] = ["camelCase", "PascalCase", "snake_case", "SCREAMING_SNAKE_CASE", "kebab-case"];

function getNextStyle(currentStyle: NamingStyle): NamingStyle {
  const currentIndex = STYLE_CYCLE.indexOf(currentStyle);
  const nextIndex = (currentIndex + 1) % STYLE_CYCLE.length;
  return STYLE_CYCLE[nextIndex];
}

function transformToStyle(words: string[], targetStyle: NamingStyle): string {
  switch (targetStyle) {
    case "camelCase":
      return toCamelCase(words);
    case "PascalCase":
      return toPascalCase(words);
    case "snake_case":
      return toSnakeCase(words);
    case "SCREAMING_SNAKE_CASE":
      return toScreamingSnakeCase(words);
    case "kebab-case":
      return toKebabCase(words);
  }
}

export function convertToNamingStyle(text: string, targetStyle: NamingStyle): string {
  const trimmed = text.trim();
  
  // Check if this is actually an identifier
  if (!trimmed || !/[a-zA-Z]/.test(trimmed)) {
    return text;
  }
  
  // Extract prefix/suffix non-alphanumeric characters
  const leadingMatch = text.match(/^(\s*)/);
  const trailingMatch = text.match(/([^a-zA-Z0-9]*)$/);
  const leading = leadingMatch ? leadingMatch[1] : "";
  const trailing = trailingMatch ? trailingMatch[1] : "";
  
  // Get the core identifier (without trailing special chars)
  const coreIdentifier = trimmed.replace(/[^a-zA-Z0-9-_]+$/, "");
  
  const words = splitWords(coreIdentifier);
  const converted = transformToStyle(words, targetStyle);
  
  return leading + converted + trailing;
}

export function convertToNextNamingStyle(
  text: string,
  currentStyle?: NamingStyle
): NamingStyleConversionResult {
  const detected = currentStyle ?? detectNamingStyle(text);
  
  // If we can't detect a style, default to camelCase
  const current = detected ?? "camelCase";
  const nextStyle = getNextStyle(current);
  
  const converted = convertToNamingStyle(text, nextStyle);
  
  return {
    text: converted,
    style: nextStyle,
  };
}
```

- [ ] **Step 4: Run test to verify conversion passes**

Run: `npm test namingStyleConverter.spec.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for edge cases**

```typescript
describe("convertToNextNamingStyle edge cases", () => {
  it("handles numbers in identifiers", () => {
    let result = convertToNextNamingStyle("user2Name");
    expect(result.text).toBe("User2Name");
    
    result = convertToNextNamingStyle(result.text);
    expect(result.text).toBe("user_2_name");
  });

  it("preserves leading and trailing whitespace", () => {
    const result = convertToNextNamingStyle("  userName  ");
    expect(result.text).toBe("  UserName  ");
  });

  it("handles empty string", () => {
    const result = convertToNextNamingStyle("");
    expect(result.text).toBe("");
  });

  it("handles single word", () => {
    const result = convertToNextNamingStyle("user");
    expect(result.text).toBe("User");
    expect(result.style).toBe("PascalCase");
  });
});
```

- [ ] **Step 6: Run test to verify edge cases pass (should already pass)**

Run: `npm test namingStyleConverter.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit conversion engine**

```bash
git add apps/desktop/src/lib/naming/namingStyleConverter.ts
git add apps/desktop/src/lib/naming/__tests__/namingStyleConverter.spec.ts
git commit -m "feat: add naming style conversion engine"
```

---

## Task 4: Shortcut Registry Integration

**Files:**
- Modify: `apps/desktop/src/lib/editor/shortcutRegistry.ts`
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/zh-CN.ts`

**Interfaces:**
- Consumes: Existing `ShortcutActionId` type and shortcut definitions
- Produces: New shortcut action `"convertNamingStyle"` with Shift+Alt+C binding

- [ ] **Step 1: Add shortcut to registry**

Find the `ShortcutActionId` type definition and add the new action:

```typescript
export type ShortcutActionId =
  | "convertNamingStyle"  // ADD THIS LINE
  | "executeSql"
  | "explainQuery"
  // ... rest of existing actions
```

Find the shortcut definitions array and add the new shortcut (near uppercaseSelection/lowercaseSelection):

```typescript
{
  id: "convertNamingStyle",
  labelKey: "settings.shortcutConvertNamingStyle",
  scope: "editor",
  defaultShortcut: "Shift+Alt+C",
},
```

- [ ] **Step 2: Add English i18n keys**

In `apps/desktop/src/locales/en.ts`, add to settings section:

```typescript
settings: {
  // ... existing keys
  shortcutConvertNamingStyle: "Toggle naming style",
  // ... rest of keys
}
```

And in editor.contextMenu section:

```typescript
editor: {
  contextMenu: {
    // ... existing keys
    convertNamingStyle: "Toggle naming style",
    // ... rest of keys
  }
}
```

- [ ] **Step 3: Add Chinese i18n keys**

In `apps/desktop/src/locales/zh-CN.ts`, add to settings section:

```typescript
settings: {
  // ... existing keys
  shortcutConvertNamingStyle: "切换命名风格",
  // ... rest of keys
}
```

And in editor.contextMenu section:

```typescript
editor: {
  contextMenu: {
    // ... existing keys
    convertNamingStyle: "切换命名风格",
    // ... rest of keys
  }
}
```

- [ ] **Step 4: Verify app compiles**

Run: `npm run dev` (or equivalent build command)
Expected: No TypeScript errors

- [ ] **Step 5: Commit shortcut registry changes**

```bash
git add apps/desktop/src/lib/editor/shortcutRegistry.ts
git add apps/desktop/src/locales/en.ts
git add apps/desktop/src/locales/zh-CN.ts
git commit -m "feat: add convertNamingStyle shortcut to registry"
```

---

## Task 5: QueryEditor CodeMirror Integration

**Files:**
- Create: `apps/desktop/src/lib/editor/queryEditorNamingStyleShortcut.ts`
- Modify: `apps/desktop/src/components/editor/QueryEditor.vue`

**Interfaces:**
- Consumes:
  - `convertToNextNamingStyle()` from namingStyleConverter.ts
  - Shortcut system from shortcutRegistry.ts
  - CodeMirror EditorView, EditorState types
- Produces:
  - `function createQueryEditorNamingStyleShortcutBindings(shortcut: string, handler: () => boolean): KeyBinding[]`

- [ ] **Step 1: Create CodeMirror key binding helper**

```typescript
import { type KeyBinding } from "@codemirror/view";
import { normalizeKeybinding } from "@/lib/editor/keybindings";

export function createQueryEditorNamingStyleShortcutBindings(
  shortcut: string,
  handler: () => boolean
): KeyBinding[] {
  const normalized = normalizeKeybinding(shortcut);
  
  return [
    {
      key: normalized,
      preventDefault: true,
      run: () => handler(),
    },
  ];
}
```

- [ ] **Step 2: Find QueryEditor.vue conversion function location**

Locate the existing `convertSelectedSqlCase` function in QueryEditor.vue (around line 1567).

- [ ] **Step 3: Add naming style conversion function to QueryEditor.vue**

Add after the existing `convertSelectedSqlCase` function:

```typescript
function convertSelectedNamingStyle(): boolean {
  if (!editorView.value) return false;
  
  const view = editorView.value;
  const state = view.state;
  const selection = state.selection.main;
  
  // Get selected text or return false if no selection
  if (selection.empty) return false;
  
  const documentText = state.doc.toString();
  const selectedText = documentText.slice(selection.from, selection.to);
  
  // Convert the selected text
  const result = convertToNextNamingStyle(selectedText);
  
  // Replace the selection with converted text
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: result.text },
    selection: { anchor: selection.from + result.text.length },
  });
  
  return true;
}
```

- [ ] **Step 4: Add import at top of QueryEditor.vue**

Add to imports section:

```typescript
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";
import { createQueryEditorNamingStyleShortcutBindings } from "@/lib/editor/queryEditorNamingStyleShortcut";
```

- [ ] **Step 5: Add keymap binding**

Find the keymap definition (around line 2132, near the uppercaseSelection binding) and add:

```typescript
...createQueryEditorNamingStyleShortcutBindings(
  shortcuts.convertNamingStyle,
  () => convertSelectedNamingStyle()
),
```

- [ ] **Step 6: Manual test in running application**

1. Start the app: `npm run dev`
2. Open a query editor
3. Type `user_name` and select it
4. Press Shift+Alt+C multiple times
5. Verify it cycles: user_name → userName → UserName → user_name → USER_NAME → user-name → userName

Expected: Text cycles through all naming styles

- [ ] **Step 7: Commit QueryEditor integration**

```bash
git add apps/desktop/src/lib/editor/queryEditorNamingStyleShortcut.ts
git add apps/desktop/src/components/editor/QueryEditor.vue
git commit -m "feat: integrate naming style conversion into QueryEditor"
```

---

## Task 6: Vue Directive for Input Fields

**Files:**
- Create: `apps/desktop/src/directives/vNamingStyleSupport.ts`
- Create: `apps/desktop/src/directives/__tests__/vNamingStyleSupport.spec.ts`

**Interfaces:**
- Consumes:
  - `convertToNextNamingStyle()` from namingStyleConverter.ts
  - Shortcut registry for Shift+Alt+C detection
- Produces:
  - Vue directive `vNamingStyleSupport` for HTMLInputElement/HTMLTextAreaElement

- [ ] **Step 1: Write failing test for directive**

```typescript
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { vNamingStyleSupport } from "../vNamingStyleSupport";

describe("vNamingStyleSupport directive", () => {
  it("converts selected text on Shift+Alt+C", async () => {
    const TestComponent = defineComponent({
      directives: { namingStyleSupport: vNamingStyleSupport },
      setup() {
        return () => h("input", { type: "text", vNamingStyleSupport: true });
      },
    });
    
    const wrapper = mount(TestComponent);
    const input = wrapper.find("input").element as HTMLInputElement;
    
    // Set value and selection
    input.value = "user_name";
    input.setSelectionRange(0, 9);
    input.focus();
    
    // Simulate Shift+Alt+C
    const event = new KeyboardEvent("keydown", {
      key: "c",
      shiftKey: true,
      altKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);
    
    // Should convert to camelCase
    expect(input.value).toBe("userName");
  });

  it("converts entire input when no selection", async () => {
    const TestComponent = defineComponent({
      directives: { namingStyleSupport: vNamingStyleSupport },
      setup() {
        return () => h("input", { type: "text", vNamingStyleSupport: true });
      },
    });
    
    const wrapper = mount(TestComponent);
    const input = wrapper.find("input").element as HTMLInputElement;
    
    input.value = "user_name";
    input.focus();
    
    const event = new KeyboardEvent("keydown", {
      key: "c",
      shiftKey: true,
      altKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);
    
    expect(input.value).toBe("userName");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test vNamingStyleSupport.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement Vue directive**

```typescript
import type { Directive } from "vue";
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";

function handleKeydown(event: KeyboardEvent): void {
  // Check for Shift+Alt+C
  if (!event.shiftKey || !event.altKey || event.key.toLowerCase() !== "c") {
    return;
  }
  
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  
  // Prevent default behavior
  event.preventDefault();
  event.stopPropagation();
  
  const value = target.value;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  
  if (start === end) {
    // No selection - convert entire content
    const result = convertToNextNamingStyle(value);
    target.value = result.text;
    target.setSelectionRange(0, result.text.length);
  } else {
    // Convert selected text
    const selectedText = value.slice(start, end);
    const result = convertToNextNamingStyle(selectedText);
    
    const newValue = value.slice(0, start) + result.text + value.slice(end);
    target.value = newValue;
    target.setSelectionRange(start + result.text.length, start + result.text.length);
  }
  
  // Trigger input event so v-model updates
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

export const vNamingStyleSupport: Directive<HTMLInputElement | HTMLTextAreaElement> = {
  mounted(el) {
    el.addEventListener("keydown", handleKeydown);
  },
  unmounted(el) {
    el.removeEventListener("keydown", handleKeydown);
  },
};
```

- [ ] **Step 4: Run test to verify directive works**

Run: `npm test vNamingStyleSupport.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit directive implementation**

```bash
git add apps/desktop/src/directives/vNamingStyleSupport.ts
git add apps/desktop/src/directives/__tests__/vNamingStyleSupport.spec.ts
git commit -m "feat: add vNamingStyleSupport directive for input fields"
```

---

## Task 7: Apply Directive to Search Input Fields

**Files:**
- Modify: `apps/desktop/src/components/grid/DataGridSearchBar.vue`
- Modify: `apps/desktop/src/components/editor/EditorSearchPanel.vue`

**Interfaces:**
- Consumes: `vNamingStyleSupport` directive from directives/vNamingStyleSupport.ts
- Produces: Search input fields with naming style conversion support

- [ ] **Step 1: Register directive in DataGridSearchBar.vue**

Add to the script section imports:

```typescript
import { vNamingStyleSupport } from "@/directives/vNamingStyleSupport";
```

Add to the script section (after imports):

```typescript
const vNamingStyle = vNamingStyleSupport;
```

Find the input element (around line 52) and add the directive:

```vue
<input
  ref="searchInput"
  v-model="searchText"
  v-naming-style
  type="search"
  ...
/>
```

- [ ] **Step 2: Test DataGridSearchBar in running app**

1. Start app: `npm run dev`
2. Open a data grid
3. Press Ctrl+F to open search bar
4. Type `user_name`
5. Press Shift+Alt+C
6. Verify it converts to `userName`

Expected: Conversion works in grid search

- [ ] **Step 3: Register directive in EditorSearchPanel.vue**

Add to the script section imports:

```typescript
import { vNamingStyleSupport } from "@/directives/vNamingStyleSupport";
```

Add to the script section:

```typescript
const vNamingStyle = vNamingStyleSupport;
```

Find the search input element and add the directive:

```vue
<input
  ref="searchInputRef"
  v-naming-style
  ...
/>
```

- [ ] **Step 4: Test EditorSearchPanel in running app**

1. Open query editor
2. Press Ctrl+F to open search panel
3. Type `user_name` in search
4. Press Shift+Alt+C
5. Verify conversion works

Expected: Conversion works in editor search

- [ ] **Step 5: Commit search field integration**

```bash
git add apps/desktop/src/components/grid/DataGridSearchBar.vue
git add apps/desktop/src/components/editor/EditorSearchPanel.vue
git commit -m "feat: add naming style conversion to search fields"
```

---

## Task 8: Integration Testing

**Files:**
- Create: `apps/desktop/src/lib/naming/__tests__/namingStyleIntegration.spec.ts`

**Interfaces:**
- Consumes: All conversion modules
- Produces: End-to-end integration tests

- [ ] **Step 1: Write integration tests**

```typescript
// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { convertToNextNamingStyle, convertToNamingStyle } from "../namingStyleConverter";

describe("Naming Style Conversion Integration", () => {
  describe("Full cycle conversion", () => {
    it("completes full cycle for multi-word identifier", () => {
      const original = "userNameList";
      
      // camelCase → PascalCase
      let result = convertToNextNamingStyle(original);
      expect(result.text).toBe("UserNameList");
      expect(result.style).toBe("PascalCase");
      
      // PascalCase → snake_case
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user_name_list");
      expect(result.style).toBe("snake_case");
      
      // snake_case → SCREAMING_SNAKE_CASE
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER_NAME_LIST");
      expect(result.style).toBe("SCREAMING_SNAKE_CASE");
      
      // SCREAMING_SNAKE_CASE → kebab-case
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user-name-list");
      expect(result.style).toBe("kebab-case");
      
      // kebab-case → camelCase (back to start)
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("userNameList");
      expect(result.style).toBe("camelCase");
    });
  });

  describe("Real-world scenarios", () => {
    it("converts SQL column name to JavaScript variable", () => {
      const sqlColumn = "user_id";
      const jsVar = convertToNamingStyle(sqlColumn, "camelCase");
      expect(jsVar).toBe("userId");
    });

    it("converts JavaScript variable to SQL column", () => {
      const jsVar = "userName";
      const sqlColumn = convertToNamingStyle(jsVar, "snake_case");
      expect(sqlColumn).toBe("user_name");
    });

    it("converts camelCase to constant", () => {
      const variable = "maxRetryCount";
      const constant = convertToNamingStyle(variable, "SCREAMING_SNAKE_CASE");
      expect(constant).toBe("MAX_RETRY_COUNT");
    });

    it("converts snake_case to CSS class", () => {
      const variable = "user_profile_card";
      const cssClass = convertToNamingStyle(variable, "kebab-case");
      expect(cssClass).toBe("user-profile-card");
    });

    it("converts PascalCase component to various styles", () => {
      const component = "UserProfileCard";
      
      expect(convertToNamingStyle(component, "camelCase")).toBe("userProfileCard");
      expect(convertToNamingStyle(component, "snake_case")).toBe("user_profile_card");
      expect(convertToNamingStyle(component, "kebab-case")).toBe("user-profile-card");
    });
  });

  describe("Edge case handling", () => {
    it("handles identifiers with numbers", () => {
      const withNumber = "user2Name";
      
      let result = convertToNextNamingStyle(withNumber);
      expect(result.text).toBe("User2Name"); // PascalCase
      
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user_2_name"); // snake_case
      
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER_2_NAME"); // SCREAMING_SNAKE_CASE
    });

    it("preserves special characters", () => {
      const withSpecial = "userName!";
      const result = convertToNextNamingStyle(withSpecial);
      expect(result.text).toBe("UserName!");
    });

    it("handles single-word identifiers", () => {
      const single = "user";
      
      let result = convertToNextNamingStyle(single);
      expect(result.text).toBe("User"); // PascalCase
      
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("user"); // snake_case (no change visible)
      
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("USER"); // SCREAMING_SNAKE_CASE
    });

    it("handles acronyms correctly", () => {
      const acronym = "XMLParser";
      
      let result = convertToNextNamingStyle(acronym);
      expect(result.text).toBe("XMLParser"); // Already PascalCase
      
      result = convertToNextNamingStyle(result.text);
      expect(result.text).toBe("xml_parser"); // snake_case
    });
  });

  describe("Whitespace preservation", () => {
    it("preserves leading whitespace", () => {
      const result = convertToNextNamingStyle("  userName");
      expect(result.text).toBe("  UserName");
    });

    it("preserves trailing whitespace", () => {
      const result = convertToNextNamingStyle("userName  ");
      expect(result.text).toBe("UserName  ");
    });

    it("preserves both leading and trailing whitespace", () => {
      const result = convertToNextNamingStyle("  userName  ");
      expect(result.text).toBe("  UserName  ");
    });
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test namingStyleIntegration.spec.ts`
Expected: PASS

- [ ] **Step 3: Run all naming style tests**

Run: `npm test naming/`
Expected: All tests PASS

- [ ] **Step 4: Commit integration tests**

```bash
git add apps/desktop/src/lib/naming/__tests__/namingStyleIntegration.spec.ts
git commit -m "test: add naming style integration tests"
```

---

## Task 9: Context Menu Integration (Optional Enhancement)

**Files:**
- Modify: `apps/desktop/src/components/editor/QueryEditor.vue`

**Interfaces:**
- Consumes: Existing context menu system
- Produces: Context menu item for "Toggle naming style"

- [ ] **Step 1: Find context menu definition in QueryEditor.vue**

Locate the existing context menu items (search for contextMenu or menu items related to "Uppercase"/"Lowercase").

- [ ] **Step 2: Add menu item after uppercase/lowercase**

Add new menu item in the convert selection section:

```typescript
{
  label: t("editor.contextMenu.convertNamingStyle"),
  accelerator: shortcuts.convertNamingStyle,
  action: () => convertSelectedNamingStyle(),
  enabled: hasSelection,
}
```

- [ ] **Step 3: Manual test context menu**

1. Start app: `npm run dev`
2. Open query editor
3. Select text like `user_name`
4. Right-click
5. Verify "Toggle naming style (Shift+Alt+C)" appears in menu
6. Click menu item
7. Verify text converts

Expected: Context menu works and shows correct shortcut

- [ ] **Step 4: Commit context menu integration**

```bash
git add apps/desktop/src/components/editor/QueryEditor.vue
git commit -m "feat: add naming style conversion to editor context menu"
```

---

## Task 10: Documentation and Final Testing

**Files:**
- Create: `docs/features/naming-style-conversion.md` (optional)
- Test: All implemented features

**Interfaces:**
- Consumes: All implemented functionality
- Produces: Documentation and validated working feature

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Manual testing checklist**

Test each scenario:
- [ ] Query editor: Select `user_name`, press Shift+Alt+C, cycles through styles
- [ ] Query editor: Multi-line selection converts each line
- [ ] Query editor: Context menu item works
- [ ] Grid search: Type `user_name`, press Shift+Alt+C, converts
- [ ] Grid search: Select partial text, press Shift+Alt+C, converts selection only
- [ ] Editor search: Same behavior as grid search
- [ ] Numbers in identifiers: `user2Name` converts correctly
- [ ] Special characters: `userName!` preserves `!`
- [ ] Undo: Ctrl+Z after conversion reverts change
- [ ] Non-identifiers: `123` doesn't change

- [ ] **Step 3: Create feature documentation (optional)**

```markdown
# Naming Style Conversion

## Overview

Convert selected text between different programming naming conventions with a single keyboard shortcut.

## Supported Styles

- **camelCase**: `userName` - JavaScript/TypeScript variables
- **PascalCase**: `UserName` - Class names, React components
- **snake_case**: `user_name` - Python, SQL identifiers
- **SCREAMING_SNAKE_CASE**: `USER_NAME` - Constants
- **kebab-case**: `user-name` - CSS classes, HTML attributes

## Usage

### Keyboard Shortcut

Press **Shift+Alt+C** to cycle through naming styles.

### Where It Works

- SQL query editor
- DDL dialogs
- Search bars (data grid, editor)
- Any input field with naming style support

### Behavior

- **With selection**: Converts only the selected text
- **Without selection** (input fields): Converts entire input content
- **Multi-line**: Converts each line independently

### Examples

Starting with `user_name`:
1. Press Shift+Alt+C → `userName` (camelCase)
2. Press Shift+Alt+C → `UserName` (PascalCase)
3. Press Shift+Alt+C → `user_name` (back to snake_case)
4. Press Shift+Alt+C → `USER_NAME` (SCREAMING_SNAKE_CASE)
5. Press Shift+Alt+C → `user-name` (kebab-case)
6. Press Shift+Alt+C → `userName` (loops back)

## Edge Cases

- Numbers: `user2Name` → `User2Name` → `user_2_name` → `USER_2_NAME`
- Special characters: Preserved at boundaries (`userName!` → `UserName!`)
- Whitespace: Leading/trailing whitespace preserved
- Single words: `user` → `User` → `user` → `USER` → `user`
```

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npm run typecheck` (or equivalent)
Expected: No TypeScript errors

- [ ] **Step 5: Commit documentation**

```bash
git add docs/features/naming-style-conversion.md
git commit -m "docs: add naming style conversion feature documentation"
```

- [ ] **Step 6: Create final summary commit**

```bash
git commit --allow-empty -m "feat: complete naming style conversion feature

- Add detection for 5 naming styles (camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE, kebab-case)
- Implement cycle conversion with Shift+Alt+C
- Integrate into QueryEditor with CodeMirror
- Add Vue directive for input field support
- Apply to search bars and editor search
- Add comprehensive unit and integration tests
- Add context menu integration
- Complete i18n for en and zh-CN"
```

---

## Validation Checklist

Before considering this plan complete, verify:

- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles without errors
- [ ] Shortcut works in query editor
- [ ] Shortcut works in search inputs
- [ ] Context menu item appears and works
- [ ] All 5 naming styles convert correctly
- [ ] Edge cases handled (numbers, special chars, whitespace)
- [ ] Undo/redo works correctly
- [ ] i18n strings present for en and zh-CN
- [ ] No regressions in existing uppercase/lowercase functionality

## Notes

- Each task builds on previous tasks - complete in order
- TDD approach: write failing test, implement, verify pass, commit
- Frequent commits after each working piece
- Manual testing supplements automated tests
- Context menu is optional but recommended for discoverability
