export type DriverImportSelection = string | { name: string };

export function isOfflineDriverPackage(selection: DriverImportSelection): boolean {
  const name = typeof selection === "string" ? selection : selection.name;
  return name.toLowerCase().endsWith(".zip");
}

export function webDriverImportAccept(requiresJavaRuntime: boolean, isWindows: boolean): string {
  if (requiresJavaRuntime) return ".zip,.jar";
  return isWindows ? ".zip,.exe" : "";
}
