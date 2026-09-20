use std::ffi::OsStr;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn new_std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    hide_std_console_window(&mut command);
    command
}

pub fn hide_std_console_window(command: &mut std::process::Command) {
    #[cfg(not(windows))]
    let _ = command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DBX is a GUI app; console subprocesses should not flash a window.
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn new_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    hide_tokio_console_window(&mut command);
    command
}

pub fn hide_tokio_console_window(command: &mut tokio::process::Command) {
    #[cfg(not(windows))]
    let _ = command;
    #[cfg(windows)]
    {
        // Keep async child processes consistent with std::process::Command.
        command.creation_flags(CREATE_NO_WINDOW);
    }
}
