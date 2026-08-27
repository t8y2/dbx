const DESKTOP_PACKAGE_NAMES = new Set(["dbx", "dbx-web"]);

export function normalizeDesktopPackageVersions(lockfile) {
  let inPackage = false;
  let packageName = "";

  return lockfile
    .split("\n")
    .map((line) => {
      if (line.startsWith("[")) {
        inPackage = line === "[[package]]";
        packageName = "";
        return line;
      }

      if (inPackage && line.startsWith('name = "')) {
        packageName = line.slice('name = "'.length, -1);
        return line;
      }

      if (inPackage && DESKTOP_PACKAGE_NAMES.has(packageName) && /^version = ".*"$/.test(line)) {
        return 'version = "<desktop-version>"';
      }

      return line;
    })
    .join("\n");
}

export function isDesktopVersionOnlyCargoLockChange(beforeLockfile, afterLockfile) {
  return beforeLockfile !== afterLockfile && normalizeDesktopPackageVersions(beforeLockfile) === normalizeDesktopPackageVersions(afterLockfile);
}
