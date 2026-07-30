import type { AiEffortCapability, AiEffortSelection } from "@/types/ai";

export function runtimeEffortFromPreference(selection: AiEffortSelection | null): AiEffortSelection | undefined {
  return selection ?? undefined;
}

export function effortSelectionEquals(left: AiEffortSelection | null, right: AiEffortSelection): boolean {
  return !!left && left.kind === right.kind && ("value" in left ? left.value === ("value" in right ? right.value : undefined) : !("value" in right));
}

function effortSelectionSupported(capability: AiEffortCapability, selection: AiEffortSelection): boolean {
  if (selection.kind === "providerDefault") return true;
  if (capability.kind === "enum") {
    return capability.options.some((option) => effortSelectionEquals(option.selection, selection));
  }
  if (capability.kind === "integer") {
    if (selection.kind === "integer") {
      const isSteppedValue = selection.value >= capability.min && selection.value <= capability.max && (selection.value - capability.min) % capability.step === 0;
      return isSteppedValue || !!capability.specialValues?.some((option) => effortSelectionEquals(option.selection, selection));
    }
    return !!capability.specialValues?.some((option) => effortSelectionEquals(option.selection, selection));
  }
  if (capability.kind === "boolean") return selection.kind === "boolean" || selection.kind === "disabled";
  if (capability.kind === "freeText") return selection.kind === "text";
  return false;
}

export function effortPreferenceUpdateForCapability(capability: AiEffortCapability, selection: AiEffortSelection | null): AiEffortSelection | null | undefined {
  if (!selection || effortSelectionSupported(capability, selection)) return undefined;
  if (capability.kind === "unsupported" || capability.kind === "freeText") return null;
  return capability.default;
}
