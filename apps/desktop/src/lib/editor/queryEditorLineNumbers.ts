import type { Extension } from "@codemirror/state";
import type { lineNumbers } from "@codemirror/view";

type LineNumbersFactory = typeof lineNumbers;
type LineNumbersConfig = NonNullable<Parameters<LineNumbersFactory>[0]>;

export function buildQueryEditorLineNumbersExtension(factory: LineNumbersFactory | null, enabled: boolean, config: LineNumbersConfig): Extension {
  return enabled && factory ? factory(config) : [];
}
