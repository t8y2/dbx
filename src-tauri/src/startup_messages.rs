//! Native-dialog messages for Windows startup failures, centralized for i18n.
//!
//! Startup-failure dialogs are shown before the webview exists (a missing or
//! damaged WebView2 runtime, or a window that never appears), so they cannot use
//! the frontend i18n resources. The Rust side keeps a small catalog here instead
//! of hard-coding `if locale.starts_with("zh")` branches at every call site.
//!
//! Coverage follows the existing native-UI precedent (`tray_menu_labels_for_locale`
//! in `lib.rs`): Simplified Chinese, Traditional Chinese and English are
//! translated; every other locale falls back to English. The frontend locales
//! remain the authoritative translation source for in-app text.
//!
//! Placeholders in templates:
//! - `{{log}}`  — full path of `startup.log`
//! - `{{url}}`  — direct download URL of the Windows 10 offline package

/// Messages for one language. Templates contain `{{log}}` / `{{url}}` placeholders.
pub(crate) struct StartupMessages {
    pub title: &'static str,
    pub missing_runtime: &'static str,
    pub damaged_runtime: &'static str,
    pub compatibility_failed: &'static str,
    pub recovery_disabled: &'static str,
}

impl StartupMessages {
    /// Fills the template placeholders. Unknown placeholders are left untouched
    /// so a translation mistake is visible instead of silently producing an empty
    /// dialog.
    pub(crate) fn render(&self, template: &'static str, log_path: &str, offline_url: &str) -> String {
        template.replace("{{log}}", log_path).replace("{{url}}", offline_url)
    }
}

const EN: StartupMessages = StartupMessages {
    title: "DBX could not start",
    missing_runtime: "【DBX could not start】\nWebView2 is missing, so DBX cannot show its window.\n\nDownload the Windows 10 offline package from the DBX website and install it (the offline package bundles WebView2, no internet required). Click Yes to open the download page:\n{{url}}\n\nIf it still fails, send this log to the maintainer:\n{{log}}",
    damaged_runtime: "【DBX could not start】\nThe WebView2 runtime is damaged, so DBX cannot show its window.\n\nDownload the Windows 10 offline package from the DBX website and install it (it bundles WebView2 and repairs it during setup). Click Yes to open the download page:\n{{url}}\n\nIf it still fails, send this log to the maintainer:\n{{log}}",
    compatibility_failed: "【DBX could not start】\nDBX tried several startup compatibility methods, but the main window still did not appear.\n\nSend this log to the maintainer for diagnosis. Click Yes to open the log folder:\n{{log}}",
    recovery_disabled: "【DBX could not start】\nThe main window did not appear and automatic compatibility retries are disabled in this environment.\n\nSend this log to the maintainer for diagnosis. Click Yes to open the log folder:\n{{log}}",
};

const ZH_CN: StartupMessages = StartupMessages {
    title: "DBX 无法启动",
    missing_runtime: "【DBX 无法启动】\n缺少 WebView2 运行时，DBX 无法显示主界面。\n\n请到 DBX 官网下载「Windows 10 离线版」安装（离线版自带 WebView2，无需联网），点“是”打开下载页：\n{{url}}\n\n如仍有问题，请把启动日志发给维护者：\n{{log}}",
    damaged_runtime: "【DBX 无法启动】\nWebView2 运行时已损坏，DBX 无法显示主界面。\n\n请到 DBX 官网下载「Windows 10 离线版」重新安装（安装时会自动修复），点“是”打开下载页：\n{{url}}\n\n如仍有问题，请把启动日志发给维护者：\n{{log}}",
    compatibility_failed: "【DBX 无法启动】\nDBX 已自动尝试多种兼容启动方式，主窗口仍未显示。\n\n请把启动日志发给维护者排查，点“是”打开日志所在文件夹：\n{{log}}",
    recovery_disabled: "【DBX 无法启动】\n主窗口没有显示，且当前环境没有继续自动尝试兼容启动方式。\n\n请把启动日志发给维护者排查，点“是”打开日志所在文件夹：\n{{log}}",
};

const ZH_TW: StartupMessages = StartupMessages {
    title: "DBX 無法啟動",
    missing_runtime: "【DBX 無法啟動】\n缺少 WebView2 執行階段，DBX 無法顯示主視窗。\n\n請到 DBX 官網下載「Windows 10 離線版」安裝（離線版自帶 WebView2，無需連網），點「是」開啟下載頁：\n{{url}}\n\n若仍有問題，請把啟動日誌寄給維護者：\n{{log}}",
    damaged_runtime: "【DBX 無法啟動】\nWebView2 執行階段已損壞，DBX 無法顯示主視窗。\n\n請到 DBX 官網下載「Windows 10 離線版」重新安裝（安裝時會自動修復），點「是」開啟下載頁：\n{{url}}\n\n若仍有問題，請把啟動日誌寄給維護者：\n{{log}}",
    compatibility_failed: "【DBX 無法啟動】\nDBX 已自動嘗試多種相容啟動方式，主視窗仍未顯示。\n\n請把啟動日誌寄給維護者排查，點「是」開啟日誌所在資料夾：\n{{log}}",
    recovery_disabled: "【DBX 無法啟動】\n主視窗沒有顯示，且目前環境沒有繼續自動嘗試相容啟動方式。\n\n請把啟動日誌寄給維護者排查，點「是」開啟日誌所在資料夾：\n{{log}}",
};

/// Normalize a BCP-47-ish locale tag and pick a catalog. Unknown locales fall
/// back to English, matching the existing native-UI behaviour.
pub(crate) fn messages_for_locale(locale: &str) -> &'static StartupMessages {
    let normalized = locale.trim().to_ascii_lowercase().replace('_', "-");
    if normalized.starts_with("zh") {
        // Traditional Chinese for Taiwan/Hong Kong/Macau and explicit Hant tags;
        // everything else Chinese is Simplified.
        if normalized.contains("-tw")
            || normalized.contains("-hk")
            || normalized.contains("-mo")
            || normalized.contains("hant")
        {
            return &ZH_TW;
        }
        return &ZH_CN;
    }
    &EN
}

/// Catalog for the current system locale.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn current() -> &'static StartupMessages {
    messages_for_locale(&sys_locale::get_locale().unwrap_or_default())
}

/// Direct link to the Windows 10 offline package for this build's version. The
/// offline package embeds the WebView2 installer, so a user with a missing or
/// damaged runtime only needs this one download. The URL pattern is the same one
/// the official release pipeline publishes (`DBX_<version>_x64-offline-setup.exe`).
pub(crate) fn offline_installer_url() -> String {
    let version = env!("CARGO_PKG_VERSION");
    format!("https://dl.dbxio.com/releases/v{version}/DBX_{version}_x64-offline-setup.exe")
}

#[cfg(test)]
mod tests {
    use super::{messages_for_locale, offline_installer_url};

    #[test]
    fn chinese_locales_are_split_between_simplified_and_traditional() {
        assert_eq!(messages_for_locale("zh-CN").title, "DBX 无法启动");
        assert_eq!(messages_for_locale("zh_CN").title, "DBX 无法启动");
        assert_eq!(messages_for_locale("zh-TW").title, "DBX 無法啟動");
        assert_eq!(messages_for_locale("zh-HK").title, "DBX 無法啟動");
        assert_eq!(messages_for_locale("zh-Hant").title, "DBX 無法啟動");
    }

    #[test]
    fn unsupported_locales_fall_back_to_english() {
        assert_eq!(messages_for_locale("ja").title, "DBX could not start");
        assert_eq!(messages_for_locale("").title, "DBX could not start");
        assert_eq!(messages_for_locale("de-DE").title, "DBX could not start");
    }

    #[test]
    fn templates_render_both_placeholders() {
        let messages = messages_for_locale("zh-CN");
        let rendered =
            messages.render(messages.missing_runtime, r"C:\logs\startup.log", "https://example.test/setup.exe");
        assert!(rendered.contains(r"C:\logs\startup.log"));
        assert!(rendered.contains("https://example.test/setup.exe"));
        assert!(!rendered.contains("{{log}}"));
        assert!(!rendered.contains("{{url}}"));
    }

    #[test]
    fn offline_installer_url_matches_the_published_asset_name() {
        let version = env!("CARGO_PKG_VERSION");
        assert_eq!(
            offline_installer_url(),
            format!("https://dl.dbxio.com/releases/v{version}/DBX_{version}_x64-offline-setup.exe")
        );
    }

    #[test]
    fn every_catalog_has_no_untranslated_placeholders_missing() {
        for messages in [&super::EN, &super::ZH_CN, &super::ZH_TW] {
            for template in [
                messages.missing_runtime,
                messages.damaged_runtime,
                messages.compatibility_failed,
                messages.recovery_disabled,
            ] {
                assert!(template.contains("{{log}}"));
                assert!(!messages.title.is_empty());
            }
        }
    }
}
