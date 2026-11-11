// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    io::{BufWriter, Error, ErrorKind, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
};

#[cfg(feature = "semver")]
use crate::semver_compat::semver_compat_string;
use crate::SingleInstanceCallback;
use tauri::{
    plugin::{self, TauriPlugin},
    AppHandle, Config, Manager, RunEvent, Runtime,
};
use tokio::io::AsyncReadExt;

struct SocketPath(PathBuf);

pub fn init<R: Runtime>(cb: Box<SingleInstanceCallback<R>>, secret: Option<String>) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(move |app, _api| {
            let socket = socket_path(app.config(), app.package_info(), secret.as_deref());
            app.manage(SocketPath(socket.clone()));

            // Notify the singleton which may or may not exist.
            match notify_singleton(&socket) {
                Ok(_) => {
                    std::process::exit(0);
                }
                Err(e) => {
                    match e.kind() {
                        ErrorKind::NotFound | ErrorKind::ConnectionRefused => {
                            // This process claims itself as singleton as likely none exists
                            socket_cleanup(&socket);
                            listen_for_other_instances(socket, app.clone(), cb);
                        }
                        _ => {
                            tracing::debug!("single_instance failed to notify - launching normally: {}", e);
                        }
                    }
                }
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(socket) = manager.try_state::<SocketPath>() {
        socket_cleanup(&socket.0);
    }
}

fn socket_path(config: &Config, _package_info: &tauri::PackageInfo, secret: Option<&str>) -> PathBuf {
    let identifier = crate::scoped_identifier(&config.identifier, secret).replace(['.', '-'].as_ref(), "_");

    #[cfg(feature = "semver")]
    let identifier = format!("{identifier}_{}", semver_compat_string(&_package_info.version),);

    // Use /tmp as socket path must be shorter than 100 chars.
    PathBuf::from(format!("/tmp/{}_si.sock", identifier))
}

fn socket_cleanup(socket: &PathBuf) {
    let _ = std::fs::remove_file(socket);
}

fn notify_singleton(socket: &PathBuf) -> Result<(), Error> {
    let stream = UnixStream::connect(socket)?;
    let mut bf = BufWriter::new(&stream);
    let cwd = std::env::current_dir().unwrap_or_default().to_str().unwrap_or_default().to_string();
    bf.write_all(cwd.as_bytes())?;
    bf.write_all(b"\0\0")?;
    let args_joined = std::env::args().collect::<Vec<String>>().join("\0");
    bf.write_all(args_joined.as_bytes())?;
    bf.flush()?;
    drop(bf);
    Ok(())
}

fn listen_for_other_instances<A: Runtime>(socket: PathBuf, app: AppHandle<A>, mut cb: Box<SingleInstanceCallback<A>>) {
    tauri::async_runtime::spawn(async move {
        match tokio::net::UnixListener::bind(socket) {
            Ok(listener) => loop {
                match listener.accept().await {
                    Ok((mut stream, _addr)) => {
                        let mut s = String::new();
                        match stream.read_to_string(&mut s).await {
                            Ok(_) => {
                                let (cwd, args) = s.split_once("\0\0").unwrap_or_default();
                                let args: Vec<String> = args.split('\0').map(String::from).collect();
                                cb(app.app_handle(), args, cwd.to_string());
                            }
                            Err(e) => {
                                tracing::debug!("single_instance failed to be notified: {e}")
                            }
                        }
                    }
                    Err(err) => {
                        tracing::debug!("single_instance failed to be notified: {}", err);
                        continue;
                    }
                }
            },
            Err(err) => {
                tracing::error!("single_instance failed to listen to other processes - launching normally: {}", err);
            }
        }
    });
}
