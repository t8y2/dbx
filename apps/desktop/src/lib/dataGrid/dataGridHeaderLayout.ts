/** Resolve header height from the full column set so virtual-window changes cannot resize it. */
export function reserveDataGridHeaderLine<T>(enabled: boolean, values: readonly T[], resolveText: (value: T, index: number) => string | null | undefined): boolean {
  return enabled && values.some((value, index) => Boolean(resolveText(value, index)?.trim()));
}
