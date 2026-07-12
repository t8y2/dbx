export interface OptionHelpPanelOffsetInput {
  activeItemTop: number;
  listCardHeight: number;
  panelHeight: number;
}

/** Aligns a help card to its active row without allowing it past the list card. */
export function optionHelpPanelOffsetTop({ activeItemTop, listCardHeight, panelHeight }: OptionHelpPanelOffsetInput): number {
  if (![activeItemTop, listCardHeight, panelHeight].every(Number.isFinite)) return 0;
  const desiredTop = Math.max(0, activeItemTop);
  const maxTop = Math.max(0, listCardHeight - Math.max(0, panelHeight));
  return Math.min(desiredTop, maxTop);
}
