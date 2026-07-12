interface CellDetailSelectionEditor {
  state: { doc: { length: number } };
  dispatch(spec: { selection: { anchor: number; head: number } }): void;
}

export function selectAllCellDetailText(editor: CellDetailSelectionEditor): boolean {
  editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } });
  return true;
}
