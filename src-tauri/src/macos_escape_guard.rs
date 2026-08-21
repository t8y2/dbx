use std::sync::{Once, OnceLock};

use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use objc2_app_kit::NSWindowStyleMask;

static ORIGINAL_DO_COMMAND: OnceLock<Imp> = OnceLock::new();
static INSTALL_ESCAPE_FULLSCREEN_GUARD: Once = Once::new();

pub(crate) fn install_escape_fullscreen_guard() {
    INSTALL_ESCAPE_FULLSCREEN_GUARD.call_once(|| unsafe {
        let Some(responder) = AnyClass::get(c"NSResponder") else {
            eprintln!("[WARN] failed to install macOS Escape fullscreen guard: NSResponder class not found");
            return;
        };
        let Some(do_command) = responder.instance_method(sel!(doCommandBySelector:)) else {
            eprintln!("[WARN] failed to install macOS Escape fullscreen guard: doCommandBySelector: not found");
            return;
        };
        let _ = ORIGINAL_DO_COMMAND.set(do_command.implementation());
        let guard: Imp = std::mem::transmute(do_command_guard as extern "C-unwind" fn(&AnyObject, Sel, Sel));
        do_command.set_implementation(guard);
    });
}

/// Whether the responder's window is in native fullscreen.
///
/// `isFullscreen` is overridden by tao and returns false while the window is
/// fullscreen, so the styleMask bit is the only reliable signal. Responders
/// without a window (or without the selector) answer false.
fn responder_in_fullscreen(any: &AnyObject) -> bool {
    unsafe {
        if !msg_send![any, respondsToSelector: sel!(window)] {
            return false;
        }
        let Some(window): Option<&AnyObject> = msg_send![any, window] else {
            return false;
        };
        if !msg_send![window, respondsToSelector: sel!(styleMask)] {
            return false;
        }
        let style: NSWindowStyleMask = msg_send![window, styleMask];
        style.contains(NSWindowStyleMask::FullScreen)
    }
}

extern "C-unwind" fn do_command_guard(self_: &AnyObject, sel: Sel, command: Sel) {
    if command == sel!(cancelOperation:) && responder_in_fullscreen(self_) {
        // Swallow the "leave fullscreen" command while fullscreen. The
        // Escape keydown already reached web content, so JS handlers (e.g.
        // closing in-app dialogs) keep working. Ctrl+Cmd+F still exits.
        return;
    }
    let Some(original) = ORIGINAL_DO_COMMAND.get() else {
        return;
    };
    let original: unsafe extern "C-unwind" fn(&AnyObject, Sel, Sel) = unsafe { std::mem::transmute(*original) };
    unsafe { original(self_, sel, command) }
}
