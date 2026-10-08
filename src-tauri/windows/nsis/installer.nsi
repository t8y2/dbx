Unicode true
XPStyle on
ManifestDPIAware true
ManifestSupportedOS all
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WinVer.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"
!searchreplace WEBVIEW2LOADERSRCPATH "${MAINBINARYSRCPATH}" "\${MAINBINARYNAME}.exe" "\WebView2Loader.dll"

!macro ReadWebView2RuntimeVersion RESULT
  StrCpy ${RESULT} ""
  ${If} ${RunningX64}
    ReadRegStr ${RESULT} HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr ${RESULT} HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} ${RESULT} == ""
    ReadRegStr ${RESULT} HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
!macroend

!macro ShouldAbortWebView2OfflineInstall INSTALL_RESULT RUNTIME_VERSION MINIMUM_COMPARISON RESULT
  StrCpy ${RESULT} 0
  ${If} ${INSTALL_RESULT} <> 0
    ${If} ${RUNTIME_VERSION} == ""
      StrCpy ${RESULT} 1
    ${ElseIf} ${MINIMUM_COMPARISON} = 1
      StrCpy ${RESULT} 1
    ${EndIf}
  ${EndIf}
!macroend

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var DbxElevated
Var DbxIsAdmin
Var DbxElevationStatus
Var DbxFileProbeError
Var DbxDirectoryProbeError
Var DbxFailedFile
Var DbxWriteFailureAction

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the begining
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${If} $UpdateMode = 1
      ${OrIf} $R0 = 1
        StrCpy $R1 "$R1 /UPDATE"
      ${EndIf}
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other erros? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DbxEnsureInstallAccess
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; Required application files must never be skipped after a write failure.
AllowSkipFiles off
LangString dbxInstallDiagnostics ${LANG_ENGLISH} "Installer: $EXEPATH$\r$\nVersion: ${VERSION}$\r$\nDestination: $INSTDIR$\r$\nAdministrator permission: $DbxIsAdmin (1=yes, 0=no)$\r$\nAutomatic elevation: $DbxElevationStatus$\r$\nAccess precheck codes (not the extraction error): file=$DbxFileProbeError, folder=$DbxDirectoryProbeError"
LangString dbxInstallDiagnostics ${LANG_SIMPCHINESE} "安装包：$EXEPATH$\r$\n版本：${VERSION}$\r$\n安装目录：$INSTDIR$\r$\n当前管理员权限：$DbxIsAdmin（1=是，0=否）$\r$\n自动提权：$DbxElevationStatus$\r$\n权限预检查错误码（非本次写入错误）：文件=$DbxFileProbeError，目录=$DbxDirectoryProbeError"
LangString dbxInstallDiagnostics ${LANG_TRADCHINESE} "安裝套件：$EXEPATH$\r$\n版本：${VERSION}$\r$\n安裝目錄：$INSTDIR$\r$\n目前系統管理員權限：$DbxIsAdmin（1=是，0=否）$\r$\n自動提升權限：$DbxElevationStatus$\r$\n權限預先檢查錯誤碼（非本次寫入錯誤）：檔案=$DbxFileProbeError，目錄=$DbxDirectoryProbeError"
LangString dbxFileWriteErrorNoIgnore ${LANG_ENGLISH} "Unable to write this file:$\r$\n$0$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\nClose DBX and retry. If it still fails, send a screenshot of this dialog.$\r$\nRetry tries again; Cancel stops installation. Required files cannot be skipped."
LangString dbxFileWriteErrorNoIgnore ${LANG_SIMPCHINESE} "无法写入文件：$\r$\n$0$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\n请关闭 DBX 后重试；若仍失败，请反馈此弹框截图。$\r$\n“重试”再次尝试；“取消”停止安装。必需文件不能跳过。"
LangString dbxFileWriteErrorNoIgnore ${LANG_TRADCHINESE} "無法寫入檔案：$\r$\n$0$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\n請關閉 DBX 後重試；若仍失敗，請回報此對話方塊截圖。$\r$\n「重試」再次嘗試；「取消」停止安裝。必要檔案不能略過。"
LangString dbxFileWriteTitle ${LANG_ENGLISH} "Unable to write an installation file"
LangString dbxFileWriteTitle ${LANG_SIMPCHINESE} "无法写入安装文件"
LangString dbxFileWriteTitle ${LANG_TRADCHINESE} "無法寫入安裝檔案"
LangString dbxManualInstall ${LANG_ENGLISH} "Manual installation"
LangString dbxManualInstall ${LANG_SIMPCHINESE} "手动安装"
LangString dbxManualInstall ${LANG_TRADCHINESE} "手動安裝"
LangString dbxFileWriteError ${LANG_ENGLISH} "$DbxFailedFile$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\nClose DBX and retry. Manual installation opens the installer folder, selects the installer, and exits this installation. No failed file can be skipped."
LangString dbxFileWriteError ${LANG_SIMPCHINESE} "$DbxFailedFile$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\n请关闭 DBX 后重试。“手动安装”将打开安装包所在目录、选中安装包，并退出当前安装。写入失败的文件不能跳过。"
LangString dbxFileWriteError ${LANG_TRADCHINESE} "$DbxFailedFile$\r$\n$\r$\n$(dbxInstallDiagnostics)$\r$\n$\r$\n請關閉 DBX 後重試。「手動安裝」將開啟安裝套件所在目錄、選取安裝套件，並結束目前安裝。寫入失敗的檔案不能略過。"
LangString dbxManualInstallFallback ${LANG_ENGLISH} "Yes: open the installer folder and exit. No: retry. Cancel: stop installation."
LangString dbxManualInstallFallback ${LANG_SIMPCHINESE} "“是”：打开安装包目录并退出；“否”：重试；“取消”：停止安装。"
LangString dbxManualInstallFallback ${LANG_TRADCHINESE} "「是」：開啟安裝套件目錄並結束；「否」：重試；「取消」：停止安裝。"
LangString dbxWin7InstallerRequired ${LANG_ENGLISH} "This installer does not support Windows 7 or Windows Server 2012 R2.$\r$\n$\r$\nPlease use the dedicated Windows 7 / Server 2012 R2 package instead.$\r$\n$\r$\nOpen the download now?"
LangString dbxWin7InstallerRequired ${LANG_SIMPCHINESE} "此安装包不支持 Windows 7 或 Windows Server 2012 R2。$\r$\n$\r$\n请改用 Windows 7 / Server 2012 R2 专用包。$\r$\n$\r$\n是否立即打开下载地址？"
LangString dbxWin7InstallerRequired ${LANG_TRADCHINESE} "此安裝套件不支援 Windows 7 或 Windows Server 2012 R2。$\r$\n$\r$\n請改用 Windows 7 / Server 2012 R2 專用套件。$\r$\n$\r$\n是否立即開啟下載網址？"
FileErrorText "$(dbxFileWriteErrorNoIgnore)" "$(dbxFileWriteErrorNoIgnore)"

LangString dbxElevationFailed ${LANG_ENGLISH} "Administrator permission is required to install DBX in this folder. Permission was denied or the elevated installer could not be started."
LangString dbxElevationFailed ${LANG_SIMPCHINESE} "安装到此目录需要管理员权限。授权已被拒绝，或无法启动提权后的安装程序。"
LangString dbxElevationFailed ${LANG_TRADCHINESE} "安裝到此目錄需要系統管理員權限。授權已被拒絕，或無法啟動提升權限後的安裝程式。"
LangString dbxElevationUserMismatch ${LANG_ENGLISH} "Please approve elevation using the same Windows account that started this installer, so DBX keeps its installation and shortcuts in the correct user profile."
LangString dbxElevationUserMismatch ${LANG_SIMPCHINESE} "请使用启动安装程序的同一个 Windows 账户授权提权，以确保 DBX 的安装信息和快捷方式保留在正确的用户配置中。"
LangString dbxElevationUserMismatch ${LANG_TRADCHINESE} "請使用啟動安裝程式的同一個 Windows 帳戶授權提升權限，以確保 DBX 的安裝資訊和捷徑保留在正確的使用者設定中。"

LangString dbxElevationNotChecked ${LANG_ENGLISH} "Not checked"
LangString dbxElevationNotChecked ${LANG_SIMPCHINESE} "未检查"
LangString dbxElevationNotChecked ${LANG_TRADCHINESE} "未檢查"
LangString dbxElevationNotRequested ${LANG_ENGLISH} "Not requested (precheck did not detect access denied)"
LangString dbxElevationNotRequested ${LANG_SIMPCHINESE} "未请求（预检查未检测到拒绝访问）"
LangString dbxElevationNotRequested ${LANG_TRADCHINESE} "未請求（預先檢查未偵測到拒絕存取）"
LangString dbxElevationAlreadyAdmin ${LANG_ENGLISH} "Already running as administrator"
LangString dbxElevationAlreadyAdmin ${LANG_SIMPCHINESE} "启动时已有管理员权限"
LangString dbxElevationAlreadyAdmin ${LANG_TRADCHINESE} "啟動時已有系統管理員權限"
LangString dbxElevationSucceeded ${LANG_ENGLISH} "Attempted; now running as administrator"
LangString dbxElevationSucceeded ${LANG_SIMPCHINESE} "已尝试，当前已有管理员权限"
LangString dbxElevationSucceeded ${LANG_TRADCHINESE} "已嘗試，目前已有系統管理員權限"
LangString dbxElevationUnconfirmed ${LANG_ENGLISH} "Attempted; administrator permission not obtained"
LangString dbxElevationUnconfirmed ${LANG_SIMPCHINESE} "已尝试，但当前未获得管理员权限"
LangString dbxElevationUnconfirmed ${LANG_TRADCHINESE} "已嘗試，但目前未取得系統管理員權限"
LangString dbxElevationFailedStatus ${LANG_ENGLISH} "Attempted; authorization denied or launch failed"
LangString dbxElevationFailedStatus ${LANG_SIMPCHINESE} "已尝试，授权被拒绝或启动失败"
LangString dbxElevationFailedStatus ${LANG_TRADCHINESE} "已嘗試，授權遭拒或啟動失敗"

Function DbxUpdateElevationStatus
  System::Call 'shell32::IsUserAnAdmin() i .s'
  Pop $DbxIsAdmin
  ${If} $DbxElevated = 1
    ${If} $DbxIsAdmin != 0
      StrCpy $DbxElevationStatus "$(dbxElevationSucceeded)"
    ${Else}
      StrCpy $DbxElevationStatus "$(dbxElevationUnconfirmed)"
    ${EndIf}
  ${ElseIf} $DbxIsAdmin != 0
    StrCpy $DbxElevationStatus "$(dbxElevationAlreadyAdmin)"
  ${Else}
    StrCpy $DbxElevationStatus "$(dbxElevationNotRequested)"
  ${EndIf}
FunctionEnd

; Keep extraction failures under our control so a third action can open the
; installer folder without ever continuing past a failed required-file write.
!macro DbxExtractFile OPTIONS SOURCE DESTINATION
  StrCpy $DbxFailedFile "${DESTINATION}"
  Call DbxUpdateElevationStatus
  ${Do}
    Call DbxPrepareFileWrite
    SetOverwrite try
    ClearErrors
    File ${OPTIONS} "${SOURCE}"
    SetOverwrite on
    ${IfNot} ${Errors}
      ${ExitDo}
    ${EndIf}
    Call DbxShowWriteError
    ${If} $DbxWriteFailureAction = ${IDRETRY}
      ${Continue}
    ${ElseIf} $DbxWriteFailureAction = 1001
      Call DbxManualInstall
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${Loop}
!macroend

Function DbxPrepareFileWrite
  Push $0
  Push $1
  ; Preserve SetOverwrite on's handling of read-only files when using try to
  ; capture errors. Keep every other existing file attribute intact.
  System::Call 'kernel32::GetFileAttributesW(w "$DbxFailedFile") i .r0'
  ${If} $0 != -1
    IntOp $1 $0 & 1
    ${If} $1 != 0
      IntOp $0 $0 & 0xFFFFFFFE
      System::Call 'kernel32::SetFileAttributesW(w "$DbxFailedFile", i r0)'
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function DbxShowWriteError
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $DbxWriteFailureAction ${IDCANCEL}
  ; Unattended failures stop installation without opening Explorer or a dialog.
  ${If} ${Silent}
    Goto dbx_write_dialog_done
  ${EndIf}

  ; NSIS uses a 32-bit stub even for x64/arm64 application payloads.
  ; TASKDIALOGCONFIG is 96 bytes; use the Windows Retry/Cancel buttons plus
  ; a localized custom Manual installation button. Cancel is the default.
  System::Call '*(i 1001, w "$(dbxManualInstall)") p .r1'
  System::Call '*(i 96, p $HWNDPARENT, p 0, i 0x1008, i 0x18, w "$(^Name)", p 65534, w "$(dbxFileWriteTitle)", w "$(dbxFileWriteError)", i 1, p r1, i 2, i 0, p 0, i 0, p 0, p 0, p 0, p 0, p 0, p 0, p 0, p 0, i 0) p .r0'
  StrCpy $3 -1
  System::Call 'comctl32::TaskDialogIndirect(p r0, *i .r2, p 0, p 0) i .r3'
  System::Free $0
  System::Free $1
  ${If} $3 = 0
    StrCpy $DbxWriteFailureAction $2
  ${Else}
    ; A safe fallback if the system cannot create a task dialog.
    MessageBox MB_YESNOCANCEL|MB_ICONSTOP|MB_DEFBUTTON3 "$(dbxFileWriteError)$\r$\n$\r$\n$(dbxManualInstallFallback)" /SD IDCANCEL IDYES dbx_write_manual IDNO dbx_write_retry
    Goto dbx_write_dialog_done
    dbx_write_manual:
      StrCpy $DbxWriteFailureAction 1001
      Goto dbx_write_dialog_done
    dbx_write_retry:
      StrCpy $DbxWriteFailureAction ${IDRETRY}
  ${EndIf}

  dbx_write_dialog_done:
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Function DbxManualInstall
  ClearErrors
  ExecShell "open" "$WINDIR\explorer.exe" '/select,"$EXEPATH"'
  ${If} ${Errors}
    ExecShell "open" "$EXEDIR"
  ${EndIf}
  ; This is a failed installation, never a successful update or a skipped file.
  SetErrorLevel 2
  Quit
FunctionEnd

; Probe without truncating the old executable. Only ACCESS_DENIED requests UAC;
; sharing violations still go through CheckIfAppIsRunning and normal retry UI.
Function DbxEnsureInstallAccess
  Push $0
  Push $1
  Push $2
  Push $3
  Call DbxUpdateElevationStatus
  StrCpy $DbxFileProbeError "$(dbxElevationNotChecked)"
  StrCpy $DbxDirectoryProbeError "$(dbxElevationNotChecked)"
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
    Pop $1
    StrCpy $DbxFileProbeError $1
    ${If} $0 != -1
      StrCpy $DbxFileProbeError 0
      System::Call 'kernel32::CloseHandle(p r0)'
    ${ElseIf} $1 = 5
      Goto dbx_elevate
    ${EndIf}
  ${EndIf}

  ; For a new destination, test the nearest existing parent directory.
  StrCpy $2 $INSTDIR
  dbx_find_parent:
    ${IfNot} ${FileExists} "$2\*.*"
      ${GetParent} "$2" $3
      ${If} $3 == ""
      ${OrIf} $3 == $2
        Goto dbx_access_done
      ${EndIf}
      StrCpy $2 $3
      Goto dbx_find_parent
    ${EndIf}
  System::Call 'kernel32::GetTempFileNameW(w r2, w "dbx", i 0, w .r3) i .r0 ?e'
  Pop $1
  StrCpy $DbxDirectoryProbeError $1
  ${If} $0 != 0
    StrCpy $DbxDirectoryProbeError 0
    Delete "$3"
  ${ElseIf} $1 = 5
    Goto dbx_elevate
  ${EndIf}
  Goto dbx_access_done

  dbx_elevate:
    ; Never loop when elevation has already been attempted or cannot help.
    System::Call 'shell32::IsUserAnAdmin() i .r0'
    ${If} $0 != 0
    ${OrIf} $DbxElevated = 1
      Goto dbx_access_done
    ${EndIf}
    ${GetParameters} $2
    StrCpy $3 $PROFILE
    ; /D must be last and unquoted (NSIS consumes the rest of the command).
    ; Internal flags precede /ARGS so application arguments stay intact.
    ClearErrors
    ExecShell "runas" "$EXEPATH" '/DBX_ELEVATED /DBX_PROFILE="$3" /DBX_LANG=$LANGUAGE $2 /D=$INSTDIR'
    ${If} ${Errors}
      StrCpy $DbxElevationStatus "$(dbxElevationFailedStatus)"
      MessageBox MB_OK|MB_ICONSTOP "$(dbxElevationFailed)$\r$\n$\r$\n$(dbxInstallDiagnostics)" /SD IDOK
      SetErrorLevel 740
      Pop $3
      Pop $2
      Pop $1
      Pop $0
      Abort
    ${EndIf}
    SetErrorLevel 0
    Quit

  dbx_access_done:
    Pop $3
    Pop $2
    Pop $1
    Pop $0
FunctionEnd

Function .onInit
  ${GetOptions} $CMDLINE "/DBX_ELEVATED" $DbxElevated
  ${IfNot} ${Errors}
    StrCpy $DbxElevated 1
    ${GetOptions} $CMDLINE "/DBX_LANG=" $0
    StrCpy $LANGUAGE $0
    ; currentUser installs must not migrate registry entries to an account
    ; entered in the UAC credential dialog.
    ${GetOptions} $CMDLINE "/DBX_PROFILE=" $0
    ${If} $0 != $PROFILE
      StrCpy $DbxFileProbeError "$(dbxElevationNotChecked)"
      StrCpy $DbxDirectoryProbeError "$(dbxElevationNotChecked)"
      Call DbxUpdateElevationStatus
      MessageBox MB_OK|MB_ICONSTOP "$(dbxElevationUserMismatch)$\r$\n$\r$\n$(dbxInstallDiagnostics)" /SD IDOK
      SetErrorLevel 740
      Quit
    ${EndIf}
  ${EndIf}

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    ${If} $DbxElevated <> 1
      !insertmacro MUI_LANGDLL_DISPLAY
    ${EndIf}
  !endif

  ; Tauri renders fixedRuntime (and skip) as an empty install mode in NSIS;
  ; DBX does not ship a skip-mode installer. Only route builds that actually
  ; install an Evergreen WebView2 runtime to the fixed WebView2 109 bundle.
  !if "${INSTALLWEBVIEW2MODE}" != ""
    ${If} ${IsWin7}
    ${OrIf} ${IsWin2012R2}
      ${If} ${Silent}
      ${OrIf} $PassiveMode = 1
        SetErrorLevel 1633
        Quit
      ${EndIf}

      MessageBox MB_ICONSTOP|MB_YESNO|MB_DEFBUTTON1 "$(dbxWin7InstallerRequired)" IDYES dbx_open_win7_installer
      SetErrorLevel 1633
      Quit

      dbx_open_win7_installer:
        ExecShell "open" "https://dl.dbxio.com/releases/v${VERSION}/DBX_${VERSION}_x64-win7-server2012r2-offline-setup.exe?v=${VERSION}"
        SetErrorLevel 1633
        Quit
    ${EndIf}
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
  ; Updaters skip the directory page. Check before any uninstall or extraction.
  Call DbxEnsureInstallAccess
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Offline packages carry the runtime they were built for. Always run that
  ; installer so an existing stale runtime is upgraded without network access.
  !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
    Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
    !insertmacro DbxExtractFile '"/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"' "${WEBVIEW2INSTALLERPATH}" "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
    DetailPrint "$(installingWebview2)"
    ExecWait '"$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" ${WEBVIEW2INSTALLERARGS} /install' $1
    Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
    StrCpy $4 ""
    StrCpy $R0 0
    ${If} $1 = 0
      DetailPrint "$(webview2InstallSuccess)"
    ${Else}
      DetailPrint "$(webview2InstallError)"
      ; Enterprise policy can make the bundled installer return a non-zero code.
      ; Continue when a usable Runtime is already registered on the machine.
      !insertmacro ReadWebView2RuntimeVersion $4
      ${If} $4 != ""
        !if "${MINIMUMWEBVIEW2VERSION}" != ""
          ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
        !endif
      ${EndIf}
    ${EndIf}
    !insertmacro ShouldAbortWebView2OfflineInstall $1 $4 $R0 $R1
    ${If} $R1 = 1
      Abort "$(webview2AbortError)"
    ${EndIf}
  !else
  ; Check if Webview2 is already installed and skip this section
  !insertmacro ReadWebView2RuntimeVersion $4

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        !insertmacro DbxExtractFile '"/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe"' "${WEBVIEW2BOOTSTRAPPERPATH}" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
  !endif
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  Call DbxUpdateElevationStatus
  DetailPrint "$(dbxInstallDiagnostics)"

  ; Copy main executable
  !insertmacro DbxExtractFile "" "${MAINBINARYSRCPATH}" "$INSTDIR\${MAINBINARYNAME}.exe"
  ; MSVC links WebView2Loader statically, while GNU builds may emit a DLL next to the binary.
  !insertmacro DbxExtractFile "/nonfatal /a /oname=WebView2Loader.dll" "${WEBVIEW2LOADERSRCPATH}" "$INSTDIR\WebView2Loader.dll"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    !insertmacro DbxExtractFile '/a "/oname={{this.[1]}}"' "{{no-escape @key}}" "$INSTDIR\{{this.[1]}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    !insertmacro DbxExtractFile '/a "/oname={{this}}"' "{{no-escape @key}}" "$INSTDIR\{{this}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  Delete "$INSTDIR\WebView2Loader.dll"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
