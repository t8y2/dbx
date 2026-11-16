import type { Ref } from "vue";
import type { EditorSettingsDraft, EditorSettingsDraftKey } from "./editorSettingsDraft";

export type EditorSettingsDraftRefMap = Record<EditorSettingsDraftKey, Ref>;

export function applyEditorSettingsDraftToRefs(draft: EditorSettingsDraft, keys: readonly EditorSettingsDraftKey[], refs: EditorSettingsDraftRefMap, transform: Partial<Record<EditorSettingsDraftKey, (value: unknown) => unknown>> = {}) {
  for (const key of keys) {
    const target = refs[key];
    const value = draft[key] as unknown;
    target.value = transform[key] ? transform[key]!(value) : value;
  }
}
