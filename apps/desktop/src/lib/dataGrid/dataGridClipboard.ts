import { eventTargetUsesNativeClipboard } from "@/lib/common/clipboard";

export type DataGridPasteIntent = "native" | "block" | "paste";

interface DataGridPasteEvent {
  target?: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

export function claimDataGridPaste(event: DataGridPasteEvent, editable: boolean, hasSelection: boolean): DataGridPasteIntent {
  if (eventTargetUsesNativeClipboard(event)) return "native";
  event.preventDefault();
  event.stopPropagation();
  return editable && hasSelection ? "paste" : "block";
}
