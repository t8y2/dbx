import type { KeyBinding } from "@codemirror/view";

interface QueryEditorSearchKeymapOptions {
  openSearch: () => boolean;
  openReplace: () => boolean;
  isReadOnly: () => boolean;
}

export function createQueryEditorSearchKeymap(options: QueryEditorSearchKeymapOptions): KeyBinding[] {
  return [
    {
      key: "Mod-f",
      preventDefault: true,
      run: options.openSearch,
    },
    {
      key: "Mod-h",
      preventDefault: true,
      // Consume the shortcut in previews without exposing mutation controls.
      run: () => options.isReadOnly() || options.openReplace(),
    },
  ];
}
