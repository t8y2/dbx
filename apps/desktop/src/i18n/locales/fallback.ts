import en from "./en";

type LocaleMessages = Record<string, unknown>;

function cloneMessage(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return mergeMessages(value as LocaleMessages, {});
  }
  return value;
}

function mergeMessages(base: LocaleMessages, override: LocaleMessages): LocaleMessages {
  const result: LocaleMessages = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = cloneMessage(value);
  }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    if (baseValue && value && typeof baseValue === "object" && typeof value === "object" && !Array.isArray(baseValue) && !Array.isArray(value)) {
      result[key] = mergeMessages(baseValue as LocaleMessages, value as LocaleMessages);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function withEnglishFallback(messages: LocaleMessages): LocaleMessages {
  return mergeMessages(en as LocaleMessages, messages);
}
