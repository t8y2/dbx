/**
 * Connection environment presets. The environment is a display-only label that
 * helps users tell dev/test/staging/prod connections apart; it does not drive
 * colors or safety guards by itself.
 */

export type ConnectionEnvironment = "development" | "testing" | "staging" | "production";

export interface ConnectionEnvironmentPreset {
  id: ConnectionEnvironment;
  /** i18n key under the `connection` section for the short badge label. */
  badgeKey: string;
  /** i18n key under the `connection` section for the full label. */
  labelKey: string;
  /** Badge styling: soft background + stronger text, light and dark. */
  badgeClass: string;
}

export const CONNECTION_ENVIRONMENTS: readonly ConnectionEnvironmentPreset[] = [
  {
    id: "development",
    badgeKey: "connection.environmentBadgeDevelopment",
    labelKey: "connection.environmentDevelopment",
    badgeClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  {
    id: "testing",
    badgeKey: "connection.environmentBadgeTesting",
    labelKey: "connection.environmentTesting",
    badgeClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  {
    id: "staging",
    badgeKey: "connection.environmentBadgeStaging",
    labelKey: "connection.environmentStaging",
    badgeClass: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  },
  {
    id: "production",
    badgeKey: "connection.environmentBadgeProduction",
    labelKey: "connection.environmentProduction",
    badgeClass: "bg-red-500/15 text-red-700 dark:text-red-300",
  },
];

export function connectionEnvironmentPreset(environment?: string): ConnectionEnvironmentPreset | undefined {
  return CONNECTION_ENVIRONMENTS.find((preset) => preset.id === environment);
}
