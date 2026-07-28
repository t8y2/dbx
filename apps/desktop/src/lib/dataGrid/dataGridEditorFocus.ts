type DataGridEditorInput = Pick<HTMLElement, "focus">;
type DataGridEditorScroller = Pick<HTMLElement, "scrollLeft" | "scrollTop">;

export function preserveDataGridScrollPosition(scroller?: DataGridEditorScroller | null) {
  if (!scroller) return () => {};
  const scrollLeft = scroller.scrollLeft;
  const scrollTop = scroller.scrollTop;
  return () => {
    if (scroller.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
    if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  };
}

export function focusDataGridEditorWithoutScrolling(input: DataGridEditorInput, scroller?: DataGridEditorScroller | null) {
  const restoreScroll = preserveDataGridScrollPosition(scroller);

  input.focus({ preventScroll: true });
  restoreScroll();
}
