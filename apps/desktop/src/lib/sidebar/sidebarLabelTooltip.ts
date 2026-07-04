export function shouldMeasureSidebarLabelOverflow(options: { hasDetailTooltip: boolean; isRenaming: boolean; usesFullWidthLabel: boolean }): boolean {
  return !options.isRenaming && !options.hasDetailTooltip && !options.usesFullWidthLabel;
}
