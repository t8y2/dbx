export const MQ_PINNED_VERSION_AUTO = "auto";

export interface MqPinnedVersionOption {
  value: string;
  label: string;
  description: string;
}

export const MQ_PINNED_VERSION_OPTIONS: MqPinnedVersionOption[] = [
  {
    value: MQ_PINNED_VERSION_AUTO,
    label: "Auto detect",
    description: "Probe /admin/v2/brokers/version and use the default 3.1.x profile if probing fails.",
  },
  {
    value: "3.1.x",
    label: "Apache Pulsar 3.1.x",
    description: "Supported Pulsar 3.x admin API profile, compatible with the 3.0/3.1 LTS line.",
  },
];

export function pinnedVersionToSelection(pinnedVersion: string | null | undefined): string {
  const value = pinnedVersion?.trim();
  if (!value) return MQ_PINNED_VERSION_AUTO;
  if (/^3(?:\.|$)/.test(value)) return "3.1.x";
  return MQ_PINNED_VERSION_AUTO;
}

export function selectionToPinnedVersion(selection: string): string | undefined {
  return MQ_PINNED_VERSION_OPTIONS.some((option) => option.value === selection) && selection !== MQ_PINNED_VERSION_AUTO ? selection : undefined;
}
