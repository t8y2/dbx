//! #11787 快捷键录入态的宿主侧配合（Windows / WebView2）。
//!
//! Windows 上 WebView2 会先吃掉一批「浏览器加速键」：`F5`/`Ctrl+R`（重载）、
//! `Ctrl+F`/`F3`（页内查找）、`Ctrl+P`（打印）、`Ctrl+±`（缩放）、`Ctrl+Shift+C`/`F12`
//! （DevTools）、前进/后退/搜索键。它们在页面之前被处理，页面既收不到（录不进搜索框），
//! 宿主也不该让它们在录入时真的执行——例如按 F5 重载整个 webview 会直接丢掉录入现场。
//!
//! 录入态下把这个开关关掉，这批键就按普通按键落到页面，由快捷键录入态自己吞掉；
//! 退出录入立刻恢复 WebView2 默认行为，非录入期的既有行为不做任何改变（包括网格 F5
//! 刷新与 WebView2 默认行为之间原有的关系）。
//!
//! 非 Windows 平台没有这层拦截（WKWebView / WebKitGTK 不消费这些键），命令是空实现。

/// 录入态与「浏览器加速键是否开启」是互斥的：录入时关掉，其余时间保持 WebView2 默认。
#[cfg(any(target_os = "windows", test))]
fn browser_accelerator_keys_enabled(recording: bool) -> bool {
    !recording
}

#[cfg(target_os = "windows")]
fn apply_browser_accelerator_keys(webview: &tauri::webview::PlatformWebview, enabled: bool) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    // Settings3 是从 Settings(v1) 经 QueryInterface 拿到的，`cast` 来自 windows-core 的
    // Interface trait（版本与 vendored wry / webview2-com-sys 一致，均为 0.61）。
    use windows_core::Interface;

    let controller = webview.controller();
    // SAFETY: WebView2 的 COM 调用契约要求在其所属 UI 线程上执行——`with_webview` 的闭包
    // 正是投递到主线程运行的。接口可用性由各步 Result 兜住：`ICoreWebView2Settings3` 需要
    // 较新的运行时（≥ 92.0.902.0），拿不到就是 Err，调用方只记日志、不影响任何功能。
    let settings3 = unsafe {
        let core = controller.CoreWebView2().map_err(|error| error.to_string())?;
        let settings = core.Settings().map_err(|error| error.to_string())?;
        settings.cast::<ICoreWebView2Settings3>().map_err(|error| error.to_string())?
    };
    // SAFETY: 同一次主线程调用里取得的 Settings3，未跨线程传递。
    unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(enabled) }.map_err(|error| error.to_string())
}

/// 前端进入/退出快捷键录入态时调用。`with_webview` 把闭包投递到主线程执行，这里不等结果
/// （失败只记日志）：关掉加速键是尽力而为的增强，失败时录入态照旧可用，只是那批浏览器
/// 加速键仍然录不进来。
#[tauri::command]
pub fn set_shortcut_recording(window: tauri::WebviewWindow, recording: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let enabled = browser_accelerator_keys_enabled(recording);
        window
            .with_webview(move |webview| {
                if let Err(error) = apply_browser_accelerator_keys(&webview, enabled) {
                    eprintln!("[WARN] failed to toggle WebView2 browser accelerator keys: {error}");
                }
            })
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, recording);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::browser_accelerator_keys_enabled;

    #[test]
    fn recording_turns_browser_accelerator_keys_off() {
        assert!(!browser_accelerator_keys_enabled(true));
        assert!(browser_accelerator_keys_enabled(false));
    }
}
