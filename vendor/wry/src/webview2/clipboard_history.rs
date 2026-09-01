// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Keeps copies made inside the WebView2 visible in the Windows Clipboard
//! History (Win+V).
//!
//! WebView2 (Chromium) writes the clipboard from an internal message window
//! that lives in the `msedgewebview2.exe` browser process. Regular pasting
//! keeps working, but the Clipboard History service ignores clipboard
//! updates owned by that window, so Win+V stays empty
//! (MicrosoftEdge/WebView2Feedback#5650).
//!
//! The host window listens for clipboard updates and, whenever an update was
//! produced by the WebView2 browser process, re-applies the exact same
//! payloads with the host window as the clipboard owner. The data itself is
//! untouched — only the ownership changes — so paste behavior is identical
//! while the history service now records the copy like it does for any other
//! application.
//!
//! Writes from any other process (including the host application itself and
//! other Chromium-based apps such as Edge or Chrome) are left alone, and
//! formats that cannot be carried across an `EmptyClipboard` safely make the
//! re-own abstain instead of destroying data.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
  CloseHandle, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
  CopyEnhMetaFileW, DeleteEnhMetaFile, DeleteObject, HENHMETAFILE, HGDIOBJ,
};
use windows::Win32::System::DataExchange::{
  AddClipboardFormatListener, CloseClipboard, EmptyClipboard, EnumClipboardFormats,
  GetClipboardData, GetClipboardOwner, OpenClipboard, RemoveClipboardFormatListener,
  SetClipboardData,
};
use windows::Win32::System::Memory::{
  GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole;
use windows::Win32::System::Threading::{
  OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
  PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
  CopyImage, GetWindowThreadProcessId, IMAGE_BITMAP, IMAGE_FLAGS, WM_CLIPBOARDUPDATE,
};

/// Subclass id of the clipboard-update hook. Arbitrary, but unique per window
/// and derived from the upstream issue number for easy grepping.
const CLIPBOARD_SUBCLASS_ID: usize = 0x5650;

/// Image name of the WebView2 browser process, which owns the internal
/// clipboard window that the Clipboard History service ignores.
const WEBVIEW2_BROWSER_PROCESS: &str = "msedgewebview2.exe";

/// First Windows 10 build shipping Clipboard History (1809). Older systems —
/// including the Windows 7/8 targets of this crate — have nothing to fix, so
/// the hook is not installed there.
const CLIPBOARD_HISTORY_MIN_BUILD: u32 = 17763;

/// Lets WebView2 finish writing all of its formats before snapshotting. The
/// work runs on a background thread, so the delay is invisible to the user.
const REOWN_DELAY: Duration = Duration::from_millis(120);

/// `OpenClipboard` fails while another thread or process (rdpclip, clipboard
/// managers, ...) still holds the clipboard open.
const OPEN_ATTEMPTS: usize = 10;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Rounds of re-owning, covering copies that land while a re-own is already
/// in progress (their update notification is coalesced away).
const REOWN_ROUNDS: usize = 3;

/// Standard clipboard format ids (`winuser.h`), widened from the windows
/// crate's `CLIPBOARD_FORMAT` constants for direct matching.
const CF_BITMAP: u32 = Ole::CF_BITMAP.0 as u32;
const CF_METAFILEPICT: u32 = Ole::CF_METAFILEPICT.0 as u32;
const CF_PALETTE: u32 = Ole::CF_PALETTE.0 as u32;
const CF_ENHMETAFILE: u32 = Ole::CF_ENHMETAFILE.0 as u32;
const CF_OWNERDISPLAY: u32 = Ole::CF_OWNERDISPLAY.0 as u32;

/// Set while a re-own worker is running so bursts of clipboard updates
/// (WebView2 writes several formats in a row) coalesce into a single worker.
static REOWN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Starts watching `hwnd` (the host window) for clipboard updates. No-op on
/// Windows versions without Clipboard History.
pub(crate) unsafe fn attach(hwnd: HWND) {
  if windows_version::OsVersion::current().build < CLIPBOARD_HISTORY_MIN_BUILD {
    return;
  }
  if AddClipboardFormatListener(hwnd).is_err() {
    return;
  }
  let _ = SetWindowSubclass(hwnd, Some(subclass_proc), CLIPBOARD_SUBCLASS_ID, 0);
}

/// Stops watching `hwnd` and removes the message hook.
pub(crate) unsafe fn detach(hwnd: HWND) {
  let _ = RemoveClipboardFormatListener(hwnd);
  let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), CLIPBOARD_SUBCLASS_ID);
}

unsafe extern "system" fn subclass_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
  _uidsubclass: usize,
  _dwrefdata: usize,
) -> LRESULT {
  if msg == WM_CLIPBOARDUPDATE {
    on_clipboard_update(hwnd);
  }
  DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Entry point for `WM_CLIPBOARDUPDATE`: schedules a re-own when the update
/// was written by the WebView2 browser process. Runs on the host window's
/// thread and only performs quick, non-blocking checks.
unsafe fn on_clipboard_update(host: HWND) {
  if !clipboard_update_from_webview2(host) {
    return;
  }
  if REOWN_IN_FLIGHT
    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
    .is_err()
  {
    return;
  }
  // `HWND` is a raw pointer and not `Send` (and edition-2021 precise capture
  // would see through any wrapper around `host.0`), so ship the handle value
  // across the thread boundary and rebuild it inside the worker. The worker
  // only uses it as the owner argument of `OpenClipboard`, which is legal
  // from any thread.
  let host = host.0 as isize;
  std::thread::spawn(move || {
    // Clears the flag when the worker ends, panic or not.
    struct InFlight;
    impl Drop for InFlight {
      fn drop(&mut self) {
        REOWN_IN_FLIGHT.store(false, Ordering::Release);
      }
    }
    let _in_flight = InFlight;
    let host = HWND(host as *mut core::ffi::c_void);

    std::thread::sleep(REOWN_DELAY);
    for _ in 0..REOWN_ROUNDS {
      let from_webview2 = unsafe { clipboard_update_from_webview2(host) };
      if !from_webview2 {
        break;
      }
      unsafe { reown_from_webview2(host) };
      std::thread::sleep(REOWN_DELAY);
    }
  });
}

/// `true` when the current clipboard update was written by the WebView2
/// browser process (and is therefore invisible to Clipboard History).
unsafe fn clipboard_update_from_webview2(host: HWND) -> bool {
  let Ok(owner) = GetClipboardOwner() else {
    return false;
  };
  // Updates we produced ourselves (and ownerless writes) need no re-own.
  if owner == host {
    return false;
  }
  window_process_image_is(owner, WEBVIEW2_BROWSER_PROCESS)
}

/// `true` when `hwnd` belongs to a process whose image name matches
/// `image_name` (case-insensitive file-name comparison).
unsafe fn window_process_image_is(hwnd: HWND, image_name: &str) -> bool {
  let mut pid = 0u32;
  GetWindowThreadProcessId(hwnd, Some(&mut pid));
  if pid == 0 {
    return false;
  }
  let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
    return false;
  };
  let mut path = [0u16; 512];
  let mut len = path.len() as u32;
  let queried = QueryFullProcessImageNameW(
    process,
    PROCESS_NAME_WIN32,
    PWSTR(path.as_mut_ptr()),
    &mut len,
  );
  let _ = CloseHandle(process);
  if queried.is_err() || len as usize >= path.len() {
    return false;
  }
  let path = String::from_utf16_lossy(&path[..len as usize]);
  process_image_matches(&path, image_name)
}

/// Pure helper: does a full image path end with `image_name`?
fn process_image_matches(image_path: &str, image_name: &str) -> bool {
  image_path
    .rsplit(['\\', '/'])
    .next()
    .is_some_and(|name| name.eq_ignore_ascii_case(image_name))
}

/// Re-applies the current clipboard contents with `host` as the owner.
/// Gives up — keeping the original clipboard untouched — if the clipboard
/// cannot be opened within the retry budget.
unsafe fn reown_from_webview2(host: HWND) {
  // The user may have copied somewhere else during the delay.
  if !clipboard_update_from_webview2(host) {
    return;
  }
  for _ in 0..OPEN_ATTEMPTS {
    if OpenClipboard(Some(host)).is_ok() {
      // An abstention (unsafe formats / nothing to re-apply) is final;
      // retrying cannot change the outcome.
      let _ = snapshot_and_reapply();
      let _ = CloseClipboard();
      return;
    }
    std::thread::sleep(OPEN_RETRY_DELAY);
  }
}

/// How a clipboard format can be carried across an `EmptyClipboard`.
#[derive(Debug, PartialEq, Eq)]
enum PayloadKind {
  /// HGLOBAL-backed: snapshot the bytes and re-set them. Covers the standard
  /// text/bitmap formats plus private (0x0200-0x7FFF) and registered
  /// (0xC000+) formats, which are HGLOBAL-backed by convention.
  Bytes,
  /// GDI `HBITMAP`: duplicated with `CopyImage` before `EmptyClipboard`.
  Bitmap,
  /// GDI `HENHMETAFILE`: duplicated with `CopyEnhMetaFileW`.
  EnhancedMetafile,
  /// Cannot be re-set safely (owner-bound or non-duplicable GDI formats).
  /// The whole re-own is skipped rather than destroying the original data.
  Unsafe,
}

fn payload_kind(format: u32) -> PayloadKind {
  match format {
    CF_BITMAP => PayloadKind::Bitmap,
    CF_ENHMETAFILE => PayloadKind::EnhancedMetafile,
    // METAFILEPICT embeds an HMETAFILE that would dangle after
    // EmptyClipboard; palettes have no duplicating API; owner-display and
    // CF_DSP* formats are meaningless without the original owner window.
    CF_METAFILEPICT | CF_PALETTE | CF_OWNERDISPLAY => PayloadKind::Unsafe,
    0x0080..=0x00FF => PayloadKind::Unsafe,
    _ => PayloadKind::Bytes,
  }
}

/// A single clipboard format carried across the `EmptyClipboard`.
enum Payload {
  Bytes { format: u32, data: Vec<u8> },
  Bitmap(HANDLE),
  EnhancedMetafile(HENHMETAFILE),
}

impl Payload {
  /// Frees duplicated GDI handles when a payload can no longer be applied.
  unsafe fn release(self) {
    match self {
      Payload::Bytes { .. } => {}
      Payload::Bitmap(handle) => {
        let _ = DeleteObject(HGDIOBJ(handle.0));
      }
      Payload::EnhancedMetafile(handle) => {
        let _ = DeleteEnhMetaFile(Some(handle));
      }
    }
  }
}

/// With the clipboard already open: snapshots every format, empties the
/// clipboard and re-sets all payloads — which transfers the ownership to the
/// window the clipboard was opened with. Returns `false` when the re-own was
/// deliberately skipped; the original clipboard is then left untouched.
unsafe fn snapshot_and_reapply() -> bool {
  let mut payloads: Vec<Payload> = Vec::new();
  let mut format = EnumClipboardFormats(0);
  while format != 0 {
    let payload = match payload_kind(format) {
      PayloadKind::Unsafe => {
        for payload in payloads {
          payload.release();
        }
        return false;
      }
      PayloadKind::Bitmap => snapshot_bitmap(format),
      PayloadKind::EnhancedMetafile => snapshot_enhmetafile(format),
      PayloadKind::Bytes => snapshot_bytes(format),
    };
    // A format that failed to snapshot cannot be re-set after the
    // `EmptyClipboard` below, so abstain rather than let it be destroyed.
    // Duplicated GDI handles collected so far are freed here.
    let Some(payload) = payload else {
      for payload in payloads {
        payload.release();
      }
      return false;
    };
    payloads.push(payload);
    format = EnumClipboardFormats(format);
  }
  if payloads.is_empty() {
    return false;
  }

  if EmptyClipboard().is_err() {
    for payload in payloads {
      payload.release();
    }
    return false;
  }

  for payload in payloads {
    apply_payload(payload);
  }
  true
}

unsafe fn snapshot_bytes(format: u32) -> Option<Payload> {
  let handle = GetClipboardData(format).ok()?;
  let hglobal = HGLOBAL(handle.0);
  let size = GlobalSize(hglobal);
  if size == 0 {
    return Some(Payload::Bytes {
      format,
      data: Vec::new(),
    });
  }
  let ptr = GlobalLock(hglobal);
  if ptr.is_null() {
    return None;
  }
  let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
  let _ = GlobalUnlock(hglobal);
  Some(Payload::Bytes { format, data })
}

unsafe fn snapshot_bitmap(format: u32) -> Option<Payload> {
  let handle = GetClipboardData(format).ok()?;
  // Zero width/height duplicate the bitmap at its original size.
  CopyImage(handle, IMAGE_BITMAP, 0, 0, IMAGE_FLAGS(0))
    .ok()
    .map(Payload::Bitmap)
}

unsafe fn snapshot_enhmetafile(format: u32) -> Option<Payload> {
  let handle = GetClipboardData(format).ok()?;
  let copy = CopyEnhMetaFileW(HENHMETAFILE(handle.0), PCWSTR::null());
  if copy.is_invalid() {
    return None;
  }
  Some(Payload::EnhancedMetafile(copy))
}

/// Hands a payload to the clipboard, which takes ownership of the handle on
/// success; failed handles are freed here.
unsafe fn apply_payload(payload: Payload) {
  match payload {
    Payload::Bytes { format, data } => {
      let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, data.len()) else {
        return;
      };
      if !data.is_empty() {
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
          let _ = GlobalFree(Some(hglobal));
          return;
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
        let _ = GlobalUnlock(hglobal);
      }
      if SetClipboardData(format, Some(HANDLE(hglobal.0))).is_err() {
        let _ = GlobalFree(Some(hglobal));
      }
    }
    Payload::Bitmap(handle) => {
      if SetClipboardData(CF_BITMAP, Some(handle)).is_err() {
        let _ = DeleteObject(HGDIOBJ(handle.0));
      }
    }
    Payload::EnhancedMetafile(handle) => {
      if SetClipboardData(CF_ENHMETAFILE, Some(HANDLE(handle.0))).is_err() {
        let _ = DeleteEnhMetaFile(Some(handle));
      }
    }
  }
}

#[cfg(test)]
mod tests {
  //! The integration tests manipulate the real system clipboard (they leave
  //! test data behind) and are serialized with a lock because cargo runs
  //! tests in parallel. The positive detection path — an owner window inside
  //! `msedgewebview2.exe` — cannot be simulated here and is covered by
  //! running the app manually (copy in the webview, check Win+V).

  use super::*;
  use std::sync::{Mutex, OnceLock};
  use windows::core::{w, HSTRING};
  use windows::Win32::Graphics::Gdi::{CreatePalette, HBRUSH, LOGPALETTE, PALETTEENTRY};
  use windows::Win32::System::LibraryLoader::GetModuleHandleW;
  use windows::Win32::System::DataExchange::{
    IsClipboardFormatAvailable, RegisterClipboardFormatW,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, HCURSOR, HICON, RegisterClassW,
    WS_OVERLAPPEDWINDOW, WNDCLASSW, WNDCLASS_STYLES, WINDOW_EX_STYLE,
  };

  static CLIPBOARD_TEST_LOCK: Mutex<()> = Mutex::new(());

  /// Only used by the tests; kept here so the lib build has no dead const.
  const CF_UNICODETEXT: u32 = Ole::CF_UNICODETEXT.0 as u32;

  unsafe extern "system" fn test_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
  ) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
  }

  /// A hidden top-level window playing the host-window role from production.
  unsafe fn create_test_window() -> HWND {
    static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();
    let class_name = HSTRING::from("WryClipboardHistoryTest");
    CLASS_REGISTERED.get_or_init(|| {
      let class = WNDCLASSW {
        style: WNDCLASS_STYLES(0),
        lpfnWndProc: Some(test_wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: GetModuleHandleW(PCWSTR::null())
          .map(Into::into)
          .ok()
          .unwrap_or_default(),
        hIcon: HICON::default(),
        hCursor: HCURSOR::default(),
        hbrBackground: HBRUSH::default(),
        lpszMenuName: PCWSTR::null(),
        lpszClassName: PCWSTR(class_name.as_ptr()),
      };
      RegisterClassW(&class);
    });
    CreateWindowExW(
      WINDOW_EX_STYLE::default(),
      PCWSTR(class_name.as_ptr()),
      PCWSTR::null(),
      WS_OVERLAPPEDWINDOW, // no WS_VISIBLE: the window stays hidden
      0,
      0,
      0,
      0,
      None,
      None,
      GetModuleHandleW(PCWSTR::null()).map(Into::into).ok(),
      None,
    )
    .unwrap()
  }

  /// `OpenClipboard` can transiently fail while other processes hold it open.
  unsafe fn open_clipboard(window: HWND) -> bool {
    for _ in 0..10 {
      if OpenClipboard(Some(window)).is_ok() {
        return true;
      }
      std::thread::sleep(Duration::from_millis(10));
    }
    false
  }

  fn utf16_bytes(text: &str) -> Vec<u8> {
    text
      .encode_utf16()
      .chain(std::iter::once(0))
      .flat_map(|unit| unit.to_le_bytes())
      .collect()
  }

  unsafe fn set_clipboard_bytes(format: u32, data: &[u8]) -> bool {
    let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, data.len()) else {
      return false;
    };
    if !data.is_empty() {
      let ptr = GlobalLock(hglobal);
      if ptr.is_null() {
        let _ = GlobalFree(Some(hglobal));
        return false;
      }
      std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
      let _ = GlobalUnlock(hglobal);
    }
    SetClipboardData(format, Some(HANDLE(hglobal.0))).is_ok()
  }

  unsafe fn read_clipboard_bytes(format: u32) -> Option<Vec<u8>> {
    let handle = GetClipboardData(format).ok()?;
    let hglobal = HGLOBAL(handle.0);
    let size = GlobalSize(hglobal);
    let ptr = GlobalLock(hglobal);
    if ptr.is_null() {
      return None;
    }
    let data = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(hglobal);
    Some(data)
  }

  unsafe fn enumerated_formats() -> Vec<u32> {
    let mut formats = Vec::new();
    let mut format = EnumClipboardFormats(0);
    while format != 0 {
      formats.push(format);
      format = EnumClipboardFormats(format);
    }
    formats
  }

  #[test]
  fn process_image_matching_is_case_insensitive_file_name_suffix() {
    assert!(process_image_matches(
      r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\131.0.2903.86\msedgewebview2.exe",
      WEBVIEW2_BROWSER_PROCESS
    ));
    assert!(process_image_matches(
      "MSEDGEWEBVIEW2.EXE",
      WEBVIEW2_BROWSER_PROCESS
    ));
    assert!(process_image_matches(
      "msedgewebview2.exe",
      WEBVIEW2_BROWSER_PROCESS
    ));
    // Other Chromium browsers and unrelated processes must not match.
    assert!(!process_image_matches(
      r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
      WEBVIEW2_BROWSER_PROCESS
    ));
    assert!(!process_image_matches(
      r"C:\Program Files\Google\Chrome\Application\chrome.exe",
      WEBVIEW2_BROWSER_PROCESS
    ));
    assert!(!process_image_matches(
      r"C:\Windows\System32\notepad.exe",
      WEBVIEW2_BROWSER_PROCESS
    ));
    assert!(!process_image_matches("", WEBVIEW2_BROWSER_PROCESS));
  }

  #[test]
  fn format_classification_matches_win32_conventions() {
    use PayloadKind::{Bitmap, Bytes, EnhancedMetafile, Unsafe};
    // HGLOBAL-backed standard formats.
    assert_eq!(payload_kind(CF_UNICODETEXT), Bytes);
    assert_eq!(payload_kind(8), Bytes); // CF_DIB
    assert_eq!(payload_kind(17), Bytes); // CF_DIBV5
    assert_eq!(payload_kind(0x0200), Bytes); // CF_PRIVATEFIRST range
    assert_eq!(payload_kind(0xC00F), Bytes); // registered ("HTML Format", ...)
    // Duplicatable GDI formats.
    assert_eq!(payload_kind(CF_BITMAP), Bitmap);
    assert_eq!(payload_kind(CF_ENHMETAFILE), EnhancedMetafile);
    // Formats that must make the re-own abstain.
    assert_eq!(payload_kind(CF_METAFILEPICT), Unsafe);
    assert_eq!(payload_kind(CF_PALETTE), Unsafe);
    assert_eq!(payload_kind(CF_OWNERDISPLAY), Unsafe);
    assert_eq!(payload_kind(0x0082), Unsafe); // CF_DSPBITMAP
    assert_eq!(payload_kind(0x008E), Unsafe); // CF_DSPENHMETAFILE
  }

  #[test]
  fn reown_roundtrip_preserves_formats_bytes_order_and_owner() {
    let _lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    unsafe {
      let window = create_test_window();
      let text = "hello 世界 🚀";
      let text_bytes = utf16_bytes(text);
      let custom_format = RegisterClipboardFormatW(w!("Wry.ClipboardHistory.Test"));
      assert_ne!(custom_format, 0);
      let custom_data = [1u8, 2, 3, 0, 255, 42];

      // Arrange: write two HGLOBAL formats owned by the test window.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(EmptyClipboard().is_ok());
      assert!(set_clipboard_bytes(CF_UNICODETEXT, &text_bytes));
      assert!(set_clipboard_bytes(custom_format, &custom_data));
      assert!(CloseClipboard().is_ok());

      assert!(open_clipboard(window), "OpenClipboard failed");
      let formats_before = enumerated_formats();
      assert!(CloseClipboard().is_ok());

      // Act: the re-own mechanics with the clipboard opened by `window`.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(
        snapshot_and_reapply(),
        "HGLOBAL-only clipboards must be re-owned"
      );
      assert!(CloseClipboard().is_ok());

      // Assert: ownership moved to the opening window — this is what makes
      // Clipboard History record the copy.
      let owner = GetClipboardOwner().unwrap();
      assert_eq!(owner, window, "the host window must own the clipboard");

      // Assert: same formats in the same order with identical bytes.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert_eq!(enumerated_formats(), formats_before);
      assert_eq!(read_clipboard_bytes(CF_UNICODETEXT).unwrap(), text_bytes);
      assert_eq!(read_clipboard_bytes(custom_format).unwrap(), custom_data);
      assert!(CloseClipboard().is_ok());

      let _ = DestroyWindow(window);
    }
  }

  #[test]
  fn reown_aborts_on_unsafe_formats_without_data_loss() {
    let _lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    unsafe {
      let window = create_test_window();
      let text_bytes = utf16_bytes("must survive");

      let logpalette = LOGPALETTE {
        palVersion: 0x300,
        palNumEntries: 1,
        palPalEntry: [PALETTEENTRY {
          peRed: 1,
          peGreen: 2,
          peBlue: 3,
          peFlags: 0,
        }],
      };
      let palette = CreatePalette(&logpalette);
      assert!(!palette.is_invalid(), "CreatePalette failed");

      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(EmptyClipboard().is_ok());
      assert!(set_clipboard_bytes(CF_UNICODETEXT, &text_bytes));
      assert!(SetClipboardData(CF_PALETTE, Some(HANDLE(palette.0))).is_ok());
      assert!(CloseClipboard().is_ok());

      // Act: the palette cannot be carried across an EmptyClipboard, so the
      // re-own must abstain instead of destroying it.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(
        !snapshot_and_reapply(),
        "re-own must abstain when an unsafe format is present"
      );
      assert!(CloseClipboard().is_ok());

      // Assert: nothing was destroyed.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert_eq!(read_clipboard_bytes(CF_UNICODETEXT).unwrap(), text_bytes);
      assert!(IsClipboardFormatAvailable(CF_PALETTE).is_ok());
      assert!(CloseClipboard().is_ok());

      let _ = DestroyWindow(window);
    }
  }

  #[test]
  fn reown_aborts_when_a_format_fails_to_snapshot() {
    let _lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    unsafe {
      let window = create_test_window();
      let text_bytes = utf16_bytes("delayed render must survive");

      // Arrange: one HGLOBAL format plus one delay-rendered format.
      // Delayed rendering is `SetClipboardData` with NULL, which returns
      // NULL on success — so the `Result` mapping is ignored and
      // registration is checked via `IsClipboardFormatAvailable` instead.
      // A render request goes to the owner's wndproc — DefWindowProcW does
      // not render — so `GetClipboardData` fails for that format during
      // the snapshot.
      let delayed_format = RegisterClipboardFormatW(w!("Wry.ClipboardHistory.Delayed"));
      assert_ne!(delayed_format, 0);

      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(EmptyClipboard().is_ok());
      assert!(set_clipboard_bytes(CF_UNICODETEXT, &text_bytes));
      let _ = SetClipboardData(delayed_format, None);
      assert!(
        IsClipboardFormatAvailable(delayed_format).is_ok(),
        "the delay-rendered format must be registered"
      );
      assert!(CloseClipboard().is_ok());

      // Act: the unsnapshotable format must abort the whole re-own.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(
        !snapshot_and_reapply(),
        "a format that fails to snapshot must make the re-own abstain"
      );
      assert!(CloseClipboard().is_ok());

      // Assert: the snapshotable data was not destroyed by the abstention.
      assert!(open_clipboard(window), "OpenClipboard failed");
      assert_eq!(read_clipboard_bytes(CF_UNICODETEXT).unwrap(), text_bytes);
      assert!(CloseClipboard().is_ok());

      let _ = DestroyWindow(window);
    }
  }

  #[test]
  fn reown_abstains_on_empty_clipboard() {
    let _lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    unsafe {
      let window = create_test_window();

      assert!(open_clipboard(window), "OpenClipboard failed");
      assert!(EmptyClipboard().is_ok());
      assert!(!snapshot_and_reapply());
      assert!(CloseClipboard().is_ok());

      let _ = DestroyWindow(window);
    }
  }

  #[test]
  fn detection_ignores_host_and_foreign_owners() {
    let _lock = CLIPBOARD_TEST_LOCK.lock().unwrap();
    unsafe {
      let owner = create_test_window();
      let host = create_test_window();

      assert!(open_clipboard(owner), "OpenClipboard failed");
      assert!(EmptyClipboard().is_ok());
      assert!(set_clipboard_bytes(CF_UNICODETEXT, &utf16_bytes("x")));
      assert!(CloseClipboard().is_ok());

      // Own write (owner == host): nothing to re-own.
      assert!(!clipboard_update_from_webview2(owner));
      // Foreign process (this test executable, not msedgewebview2.exe):
      // must be left alone.
      assert!(!clipboard_update_from_webview2(host));

      // attach/detach smoke test on a real window.
      attach(host);
      detach(host);

      let _ = DestroyWindow(owner);
      let _ = DestroyWindow(host);
    }
  }
}
