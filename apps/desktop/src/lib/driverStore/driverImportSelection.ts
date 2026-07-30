export type DriverImportSelection = string | { name: string };

export function isOfflineDriverPackage(selection: DriverImportSelection): boolean {
  const name = typeof selection === "string" ? selection : selection.name;
  const lowerName = name.toLowerCase();
  return lowerName.endsWith(".zip") || lowerName.endsWith(".tar.zst");
}

export function webDriverImportAccept(requiresJavaRuntime: boolean, isWindows: boolean): string {
  if (requiresJavaRuntime) return ".zip,.tar.zst,.jar";
  return isWindows ? ".zip,.tar.zst,.exe" : "";
}
