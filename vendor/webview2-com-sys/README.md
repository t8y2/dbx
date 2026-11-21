# webview2-com-sys

This crate implements unsafe Rust bindings for the [WebView2](https://aka.ms/webview2) COM APIs using the [Windows](https://github.com/microsoft/windows-rs) crate.

## Getting Started

This crate has a friendlier wrapper in [webview2-com](https://crates.io/crates/webview2-com).

## DBX vendoring

DBX vendors this crate to make the Windows 7 WebView2 loader an explicit build input.
The crate source matches upstream `webview2-com-sys` 0.38.2.

`build.rs` selects the loader directory by target:

- The custom `x86_64-win7-windows-msvc` target uses `win7/x64/`.
- Every other Windows target uses the upstream `x86/`, `x64/`, or `arm64/` directory.

The old loader preparation scripts replaced a file inside the cargo registry.
That replacement was invisible to compile caches.
A release once shipped a binary linked against the wrong loader (see the comment in `.github/workflows/release.yml`).
The vendored copy removes that failure mode.

### Loader provenance

| Directory | Source | WebView2 SDK | SHA256 |
| --- | --- | --- | --- |
| `x86/` | crates.io `webview2-com-sys` 0.38.2 | 1.0.3650.58 | `6649ce9ca24e7a5693ee54178f42e0378004ce537d82d15354e6c9adb467bc16` (static) |
| `x64/` | crates.io `webview2-com-sys` 0.38.2 | 1.0.3650.58 | `0659b741bde6348d4c4a6ec4ceb9af50e3d0048ed9cd3c8659bccbb61fde55ee` (static) |
| `arm64/` | crates.io `webview2-com-sys` 0.38.2 | 1.0.3650.58 | `506ffde430bee7f91f2ce1a078effb5289b7cec3b0c7283647f0842def524ab4` (static) |
| `win7/x64/` | NuGet `Microsoft.Web.WebView2` 1.0.902.49 | 1.0.902.49 | `aa5c26670f1b18d0fa2a56ac3f1ae30110c332a8bfbd555a7be3e548d1b0da3d` (static), `fdf978ba706578b05967d7f0181f462147864a5aa74f36016a62cb3d3dbe6909` (`WebView2Loader.dll`) |

`build.rs` verifies the two pinned `win7/x64/` hashes at build time.
`.github/scripts/prepare-webview2-win7-loader.ps1` verifies the same hashes and stages the loader DLL for the runtime probe.

### License

The Rust source keeps the upstream MIT license.
The Microsoft WebView2 loader files keep the Microsoft WebView2 SDK license.
The repository commits them to build the offline Windows 7 / Server 2012 R2 installer.
