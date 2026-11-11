// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Ensure a single instance of your tauri app is running.

#![doc(
    html_logo_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png",
    html_favicon_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png"
)]
#![cfg(not(any(target_os = "android", target_os = "ios")))]

use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};
mod scope;
pub(crate) use scope::scoped_identifier;

#[cfg(target_os = "windows")]
#[path = "platform_impl/windows.rs"]
mod platform_impl;
#[cfg(target_os = "linux")]
#[path = "platform_impl/linux.rs"]
mod platform_impl;
#[cfg(target_os = "macos")]
#[path = "platform_impl/macos.rs"]
mod platform_impl;

#[cfg(feature = "semver")]
mod semver_compat;

pub(crate) type SingleInstanceCallback<R> = dyn FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static;

pub fn init<R: Runtime, F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>(f: F) -> TauriPlugin<R> {
    Builder::new().callback(f).build()
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    platform_impl::destroy(manager)
}

pub struct Builder<R: Runtime> {
    callback: Box<SingleInstanceCallback<R>>,
    dbus_id: Option<String>,
    secret: Option<String>,
}

impl<R: Runtime> Default for Builder<R> {
    fn default() -> Self {
        Self {
            callback: Box::new(move |_app, _args, _| {
                #[cfg(feature = "deep-link")]
                if let Some(deep_link) = _app.try_state::<tauri_plugin_deep_link::DeepLink<R>>() {
                    deep_link.handle_cli_arguments(_args.iter());
                }
            }),
            dbus_id: None,
            secret: None,
        }
    }
}

impl<R: Runtime> Builder<R> {
    pub fn new() -> Self {
        Default::default()
    }

    /// Scope the lock and argument handoff endpoint without changing the app identifier.
    /// Use a stable, ASCII alphanumeric value such as a digest of a profile directory.
    pub fn secret(mut self, secret: impl Into<String>) -> Self {
        let secret = secret.into();
        assert!(
            !secret.is_empty() && secret.bytes().all(|b| b.is_ascii_alphanumeric()),
            "single-instance secret must be ASCII alphanumeric"
        );
        self.secret = Some(secret);
        self
    }

    /// Function to call when a secondary instance was opened by the user and killed by the plugin.
    /// If the `deep-link` feature is enabled, the plugin triggers the deep-link plugin before executing the callback.
    pub fn callback<F: FnMut(&AppHandle<R>, Vec<String>, String) + Send + Sync + 'static>(mut self, mut f: F) -> Self {
        self.callback = Box::new(move |app, args, cwd| {
            #[cfg(feature = "deep-link")]
            if let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<R>>() {
                deep_link.handle_cli_arguments(args.iter());
            }
            f(app, args, cwd)
        });
        self
    }

    /// Set a custom D-Bus ID, used on Linux. The plugin will append a `.SingleInstance` subname.
    /// For example `com.mycompany.myapp` will result in the plugin registering its D-Bus service on `com.mycompany.myapp.SingleInstance`.
    /// Usually you want the same base ID across all components in your app.
    ///
    /// Defaults to the app's bundle identifier set in tauri.conf.json.
    pub fn dbus_id(mut self, dbus_id: impl Into<String>) -> Self {
        self.dbus_id = Some(dbus_id.into());
        self
    }

    pub fn build(self) -> TauriPlugin<R> {
        platform_impl::init(
            self.callback,
            self.secret,
            #[cfg(target_os = "linux")]
            self.dbus_id,
        )
    }
}
