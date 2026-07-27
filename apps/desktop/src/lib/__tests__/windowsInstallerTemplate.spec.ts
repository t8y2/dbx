import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(resolve(process.cwd(), "src-tauri/windows/nsis/installer.nsi"), "utf8");

describe("Windows offline installer template", () => {
  it("continues after an offline Runtime installer failure when a Runtime is registered", () => {
    const offlineStart = template.indexOf('!if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"');
    const regularInstallerStart = template.indexOf("  !else\n  ; Check if Webview2 is already installed", offlineStart);
    const offlineBlock = template.slice(offlineStart, regularInstallerStart);

    const installerFailure = offlineBlock.indexOf('DetailPrint "$(webview2InstallError)"');
    const runtimeRecheck = offlineBlock.indexOf("!insertmacro ReadWebView2RuntimeVersion $4", installerFailure);
    const minimumVersionCheck = offlineBlock.indexOf('${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0', runtimeRecheck);
    const missingRuntimeCheck = offlineBlock.indexOf('${If} $4 == ""', minimumVersionCheck);
    const abort = offlineBlock.indexOf('Abort "$(webview2AbortError)"', missingRuntimeCheck);

    expect(offlineStart).toBeGreaterThanOrEqual(0);
    expect(regularInstallerStart).toBeGreaterThan(offlineStart);
    expect(installerFailure).toBeGreaterThanOrEqual(0);
    expect(runtimeRecheck).toBeGreaterThan(installerFailure);
    expect(minimumVersionCheck).toBeGreaterThan(runtimeRecheck);
    expect(missingRuntimeCheck).toBeGreaterThan(minimumVersionCheck);
    expect(abort).toBeGreaterThan(missingRuntimeCheck);
  });

  it("uses the same registry detection before and after Runtime installation", () => {
    const runtimeChecks = template.match(/!insertmacro ReadWebView2RuntimeVersion \$4/g) ?? [];

    expect(runtimeChecks).toHaveLength(2);
    expect(template).toContain('ReadRegStr ${RESULT} HKLM "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2APPGUID}" "pv"');
    expect(template).toContain('ReadRegStr ${RESULT} HKCU "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2APPGUID}" "pv"');
  });
});
