const JAVA_SYSTEM_PROPERTY_PREFIX = "-D";
const SHELL_QUOTE_PATTERN = /["']/;

export class DamengJvmSystemPropertyError extends Error {
  constructor(readonly lineNumber: number) {
    super(`Invalid Dameng JVM system property on line ${lineNumber}`);
    this.name = "DamengJvmSystemPropertyError";
  }
}

export function damengJvmSystemPropertiesText(options?: string[]): string {
  return (options ?? [])
    .map((option) => option.trim())
    .filter(Boolean)
    .join("\n");
}

export function parseDamengJvmSystemProperties(value: string): string[] {
  const options: string[] = [];

  for (const [index, line] of value.split(/\r?\n/).entries()) {
    const option = line.trim();
    if (!option) continue;
    if (!isJavaSystemProperty(option)) {
      throw new DamengJvmSystemPropertyError(index + 1);
    }
    options.push(option);
  }

  return options;
}

function isJavaSystemProperty(option: string): boolean {
  if (!option.startsWith(JAVA_SYSTEM_PROPERTY_PREFIX) || SHELL_QUOTE_PATTERN.test(option)) return false;
  const property = option.slice(JAVA_SYSTEM_PROPERTY_PREFIX.length);
  const separator = property.indexOf("=");
  const key = separator >= 0 ? property.slice(0, separator) : property;
  return key.length > 0 && !/\s/.test(key);
}
