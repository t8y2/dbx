use std::sync::Mutex;

use tauri::Manager;

/// Beta build version the renderer has confirmed as promoted to a stable release.
///
/// Stable artifacts are not rebuilt: the promotion workflow moves the daily beta
/// Release onto the plain `vX.Y.Z` tag, so the installed binary keeps its
/// `X.Y.Z-beta.YYYYMMDD.N` version even though that exact build is now stable.
/// The renderer learns this from the stable manifest (`promoted_from`) and
/// reports it here, so the native About panel can show the stable version the
/// same way Settings → About already does.
pub struct PromotedBuildState {
    build: Mutex<Option<String>>,
}

impl PromotedBuildState {
    pub fn new() -> Self {
        Self { build: Mutex::new(None) }
    }

    /// Stores the promoted build version and reports whether it changed, so the
    /// caller only rebuilds native menus when the panel content can differ.
    pub fn replace(&self, build: Option<String>) -> bool {
        let mut current = self.build.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == build {
            return false;
        }
        *current = build;
        true
    }

    /// Only the macOS app menu reads this back; other platforms merely report
    /// into the state, so the getter is unused there.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn get(&self) -> Option<String> {
        self.build.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

impl Default for PromotedBuildState {
    fn default() -> Self {
        Self::new()
    }
}

/// `(version, short_version)` pairs for the native About panel.
///
/// `version` fills `NSAboutPanelOptionApplicationVersion` and `short_version`
/// the parenthesized `NSAboutPanelOptionVersion`; when `short_version` is absent
/// AppKit falls back to `CFBundleVersion`, which is stamped with the same build
/// string, so a promoted build would read `X.Y.Z-beta… (X.Y.Z-beta…)`.
///
/// A promoted build resolves to `(X.Y.Z, X.Y.Z-beta…)`, matching the copied
/// support info: the stable version up front, the exact build kept for bug
/// reports. Everything else keeps the raw version with no parenthesized build.
/// The decision itself lives in `dbx_platform::version` so it is unit-tested
/// where the test binary can run.
///
/// Compiled on every platform (not just macOS) so the Windows/Linux build
/// type-checks the panel logic; only macOS calls it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn about_version_pair(build: &str, promoted: Option<&str>) -> (String, Option<String>) {
    match dbx_platform::version::promoted_base_version(build, promoted) {
        Some(base) => (base, Some(dbx_platform::version::normalize_version(build))),
        None => (build.trim().to_string(), None),
    }
}

/// Seeds the marker from storage and rebuilds the app menu when that changes
/// what the About panel shows.
///
/// The menu — including its About metadata — is built before storage exists, so
/// without this a cold start would keep showing a promoted build's beta version
/// until the renderer reports it.
///
/// Compiled on every platform for the same type-checking reason; only macOS
/// rebuilds a native app menu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn apply_stored_promotion(app: &tauri::AppHandle, stored: Option<String>) {
    // A marker left over from an older build says nothing about this one.
    let running = dbx_platform::version::normalize_version(env!("CARGO_PKG_VERSION"));
    let Some(stored) = stored.filter(|value| dbx_platform::version::normalize_version(value) == running) else {
        // Nothing stored says nothing about this build either: keep whatever the
        // state already holds instead of clearing a fresher report.
        return;
    };
    let changed = app.try_state::<PromotedBuildState>().is_some_and(|state| state.replace(Some(stored)));
    if !changed {
        return;
    }
    if let Err(error) = crate::refresh_native_menus(app) {
        log::warn!("[ABOUT] failed to refresh native menus after loading the promoted build: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::PromotedBuildState;

    const BUILD: &str = "0.6.67-beta.20261105.1";

    #[test]
    fn state_reports_only_real_changes() {
        let state = PromotedBuildState::new();
        assert!(state.replace(Some(BUILD.to_string())));
        assert!(!state.replace(Some(BUILD.to_string())));
        assert_eq!(state.get().as_deref(), Some(BUILD));
        assert!(state.replace(None));
        assert!(!state.replace(None));
        assert_eq!(state.get(), None);
    }
}
