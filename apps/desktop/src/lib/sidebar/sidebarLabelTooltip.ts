export function shouldMeasureSidebarLabelOverflow(options: { hasDetailTooltip: boolean; isRenaming: boolean; usesFullWidthLabel: boolean; tooltipsDisabled: boolean }): boolean {
  return !options.tooltipsDisabled && !options.isRenaming && !options.hasDetailTooltip && !options.usesFullWidthLabel;
}
