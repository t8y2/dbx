use std::sync::{Once, OnceLock};

use objc2::{
    ffi,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use objc2_app_kit::NSApplicationTerminateReply;
use tauri::{AppHandle, Manager};

use crate::{request_app_close, CloseBehaviorState};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static INSTALL_DOCK_QUIT_HANDLER: Once = Once::new();

pub(crate) fn install_dock_quit_handler(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    INSTALL_DOCK_QUIT_HANDLER.call_once(|| {
        let Some(delegate_class) = AnyClass::get(c"TaoAppDelegateParent") else {
            eprintln!("[WARN] failed to install macOS Dock quit handler: TaoAppDelegateParent not found");
            return;
        };

        let imp: Imp = unsafe {
            std::mem::transmute(
                application_should_terminate
                    as extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) -> NSApplicationTerminateReply,
            )
        };
        let method_types = c"Q@:@";

        // Tao's app delegate does not implement applicationShouldTerminate:, so Dock Quit can
        // bypass Tauri's ExitRequested event. Add the method to Tao's registered delegate class
        // and route that native quit request through DBX's normal close confirmation flow.
        let added = unsafe {
            ffi::class_addMethod(
                delegate_class as *const AnyClass as *mut AnyClass,
                sel!(applicationShouldTerminate:),
                imp,
                method_types.as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!("[WARN] failed to install macOS Dock quit handler: applicationShouldTerminate: already exists");
        }
    });
}

extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _sender: &AnyObject,
) -> NSApplicationTerminateReply {
    let Some(app) = APP_HANDLE.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };

    if app.try_state::<CloseBehaviorState>().map(|state| state.take_confirmed_exit()).unwrap_or(false) {
        return NSApplicationTerminateReply::TerminateNow;
    }

    request_app_close(app, "quit");
    NSApplicationTerminateReply::TerminateCancel
}
