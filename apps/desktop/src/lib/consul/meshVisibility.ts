function externalConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function consulMeshWorkspaceVisible(externalConfig: unknown): boolean {
  const config = externalConfigRecord(externalConfig);
  return config.consulMeshVisible === true;
}
