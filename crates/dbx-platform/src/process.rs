use std::ffi::OsStr;
use std::io;
use std::process::ExitStatus;

use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x00000004;

/// A Tokio child together with the process-tree ownership required to stop it safely.
///
/// Windows children are created suspended, assigned to a private Job Object, and only then
/// resumed. This ensures descendants inherit the Job before any plugin code can run. Other
/// platforms intentionally keep Tokio's existing direct-child behavior.
pub struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: windows::ProcessTreeJob,
}

impl ManagedChild {
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Force the owned process tree to exit and wait until the termination is observable.
    ///
    /// On Windows this terminates the Job Object and confirms it has no active processes before
    /// reaping the launcher. On Unix and other platforms it preserves Tokio's direct-child kill
    /// semantics.
    pub async fn terminate(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate_and_wait().await?;
            self.child.wait().await?;
            Ok(())
        }

        #[cfg(not(windows))]
        {
            if self.child.try_wait()?.is_none() {
                self.child.kill().await?;
            }
            Ok(())
        }
    }
}

/// Spawn a process with explicit ownership of its lifecycle.
///
/// On Windows, failure to create or assign the private Job Object is returned as a spawn error;
/// the process is never resumed without ownership. Dropping the returned child closes its Job
/// Object, whose `KILL_ON_JOB_CLOSE` limit terminates any remaining members.
pub async fn spawn_managed_child(command: &mut Command) -> io::Result<ManagedChild> {
    command.kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.as_std_mut().creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut job = windows::ProcessTreeJob::new()?;
        let mut child = command.spawn()?;
        let Some(pid) = child.id() else {
            let cleanup = kill_child_and_wait(&mut child).await;
            return Err(spawn_cleanup_error(
                io::Error::other("Windows returned a child process without a PID"),
                cleanup.err(),
            ));
        };

        if let Err(error) = job.assign(&child) {
            let cleanup = kill_child_and_wait(&mut child).await;
            return Err(spawn_cleanup_error(error, cleanup.err()));
        }
        if let Err(error) = job.resume_child(pid) {
            if let Err(termination_error) = job.terminate_and_wait().await {
                // terminate_and_wait closes the job on failure, triggering its kill-on-close limit.
                let cleanup_error = match wait_for_child_exit(&mut child).await {
                    Ok(()) => termination_error,
                    Err(wait_error) => io::Error::new(
                        termination_error.kind(),
                        format!("{termination_error}; additionally failed to wait for launcher: {wait_error}"),
                    ),
                };
                return Err(spawn_cleanup_error(error, Some(cleanup_error)));
            }
            let cleanup = wait_for_child_exit(&mut child).await;
            return Err(spawn_cleanup_error(error, cleanup.err()));
        }

        Ok(ManagedChild { child, job })
    }

    #[cfg(not(windows))]
    {
        command.spawn().map(|child| ManagedChild { child })
    }
}

#[cfg(windows)]
async fn kill_child_and_wait(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_none() {
        child.kill().await?;
    }
    Ok(())
}

#[cfg(windows)]
async fn wait_for_child_exit(child: &mut Child) -> io::Result<()> {
    child.wait().await.map(|_| ())
}

#[cfg(windows)]
fn spawn_cleanup_error(error: io::Error, cleanup_error: Option<io::Error>) -> io::Error {
    match cleanup_error {
        Some(cleanup_error) => io::Error::new(
            error.kind(),
            format!("{error}; additionally failed to confirm child cleanup: {cleanup_error}"),
        ),
        None => error,
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::time::Duration;

    use tokio::process::Child;
    use tokio::time::{sleep, Instant};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    const PROCESS_TREE_TERMINATION_TIMEOUT: Duration = Duration::from_secs(10);
    const PROCESS_TREE_POLL_INTERVAL: Duration = Duration::from_millis(10);

    pub(super) struct ProcessTreeJob {
        handle: Option<OwnedHandle>,
        terminated: bool,
    }

    impl ProcessTreeJob {
        pub(super) fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                let error = io::Error::last_os_error();
                return Err(io::Error::new(error.kind(), format!("CreateJobObjectW failed: {error}")));
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle() as HANDLE,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                let error = io::Error::last_os_error();
                return Err(io::Error::new(
                    error.kind(),
                    format!("failed to enable kill-on-close for plugin Job Object: {error}"),
                ));
            }
            Ok(Self { handle: Some(handle), terminated: false })
        }

        pub(super) fn assign(&self, child: &Child) -> io::Result<()> {
            let job = self.handle()?;
            let process = child.raw_handle().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "suspended plugin child exited before Job assignment")
            })?;
            let assigned = unsafe { AssignProcessToJobObject(job, process as HANDLE) };
            if assigned == 0 {
                let error = io::Error::last_os_error();
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "failed to assign suspended plugin process to its Windows Job Object (the host job may not allow nesting): {error}"
                    ),
                ));
            }
            Ok(())
        }

        pub(super) fn resume_child(&self, pid: u32) -> io::Result<()> {
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot as RawHandle) };
            let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut found_thread = None;
            let mut has_entry = unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) != 0 };
            while has_entry {
                if entry.th32OwnerProcessID == pid && found_thread.replace(entry.th32ThreadID).is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("suspended plugin process {pid} unexpectedly has multiple threads"),
                    ));
                }
                has_entry = unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) != 0 };
            }
            let thread_id = found_thread.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("primary thread for suspended process {pid} was not found"),
                )
            })?;
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread as RawHandle) };
            let previous_suspend_count = unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
            if previous_suspend_count == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            if previous_suspend_count != 1 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "suspended plugin process {pid} had unexpected primary-thread suspend count {previous_suspend_count}"
                    ),
                ));
            }
            Ok(())
        }

        pub(super) async fn terminate_and_wait(&mut self) -> io::Result<()> {
            if self.terminated {
                return Ok(());
            }

            let active_processes = match self.active_processes() {
                Ok(active_processes) => active_processes,
                Err(error) => {
                    self.close();
                    return Err(error);
                }
            };
            if active_processes > 0 {
                let terminated = unsafe { TerminateJobObject(self.handle()?, 1) };
                if terminated == 0 {
                    let error = io::Error::last_os_error();
                    match self.active_processes() {
                        Ok(0) => {}
                        Ok(_) => {
                            self.close();
                            return Err(io::Error::new(
                                error.kind(),
                                format!("failed to terminate Windows plugin process tree: {error}"),
                            ));
                        }
                        Err(query_error) => {
                            self.close();
                            return Err(io::Error::new(
                                query_error.kind(),
                                format!("failed to verify Windows plugin process-tree termination: {query_error}"),
                            ));
                        }
                    }
                }
            }

            let deadline = Instant::now() + PROCESS_TREE_TERMINATION_TIMEOUT;
            loop {
                match self.active_processes() {
                    Ok(0) => {
                        self.terminated = true;
                        self.close();
                        return Ok(());
                    }
                    Ok(_) if Instant::now() < deadline => sleep(PROCESS_TREE_POLL_INTERVAL).await,
                    Ok(_) => {
                        self.close();
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "timed out waiting for the Windows plugin process tree to exit",
                        ));
                    }
                    Err(error) => {
                        self.close();
                        return Err(error);
                    }
                }
            }
        }

        fn active_processes(&self) -> io::Result<u32> {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle()?,
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(accounting.ActiveProcesses)
        }

        fn handle(&self) -> io::Result<HANDLE> {
            self.handle
                .as_ref()
                .map(|handle| handle.as_raw_handle() as HANDLE)
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "Windows process-tree Job Object is closed"))
        }

        fn close(&mut self) {
            drop(self.handle.take());
        }
    }
}

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

#[cfg(all(test, windows))]
mod tests {
    use std::fs;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{new_tokio_command, spawn_managed_child, ManagedChild};
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn windows_batch_launcher_shutdown_and_drop_terminate_descendants_across_lifecycles() {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("dbx-plugin-process-tree-{}-{timestamp}", std::process::id())),
        );
        fs::create_dir_all(&directory.0).unwrap();
        let executable = std::env::current_exe().unwrap();
        let launcher = directory.0.join("launcher.bat");
        fs::write(&launcher, b"@echo off\r\n\"%DBX_PROCESS_TREE_TEST_EXE%\" windows_process_tree_test_descendant\r\n")
            .unwrap();

        for lifecycle in 0..3 {
            let pid_file = directory.0.join(format!("descendant-{lifecycle}.pid"));
            let mut command = new_tokio_command(&launcher);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .env("DBX_PROCESS_TREE_TEST_EXE", &executable)
                .env("DBX_PROCESS_TREE_TEST_PID_FILE", &pid_file);
            let mut child =
                spawn_managed_child(&mut command).await.expect("launcher should be assigned before it runs");
            let launcher_pid = child.id().expect("launcher should have a PID");
            let descendant_pid = wait_for_descendant_pid(&mut child, &pid_file).await;
            let launcher_handle = open_process_handle(launcher_pid);
            let descendant_handle = open_process_handle(descendant_pid);
            assert!(
                process_is_running(&launcher_handle),
                "batch launcher {launcher_pid} should be alive before shutdown"
            );
            assert!(
                process_is_running(&descendant_handle),
                "descendant {descendant_pid} should be alive before shutdown"
            );

            if lifecycle == 2 {
                drop(child);
            } else {
                tokio::time::timeout(Duration::from_secs(15), child.terminate())
                    .await
                    .expect("process-tree shutdown must be bounded")
                    .expect("Job Object termination should succeed");
            }

            assert_process_exited(&launcher_handle, launcher_pid);
            assert_process_exited(&descendant_handle, descendant_pid);
        }
    }

    async fn wait_for_descendant_pid(child: &mut ManagedChild, pid_file: &std::path::Path) -> u32 {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(contents) = fs::read_to_string(pid_file) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    return pid;
                }
            }
            if let Some(status) = child.try_wait().expect("launcher status should be readable") {
                panic!("batch launcher exited before descendant startup with {status}");
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for the long-running descendant PID");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn open_process_handle(pid: u32) -> OwnedHandle {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null(), "failed to open process {pid}: {}", std::io::Error::last_os_error());
        unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
    }

    fn process_is_running(handle: &OwnedHandle) -> bool {
        match unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 0) } {
            WAIT_TIMEOUT => true,
            WAIT_OBJECT_0 => false,
            WAIT_FAILED => panic!("failed to query process handle: {}", std::io::Error::last_os_error()),
            result => panic!("unexpected WaitForSingleObject result: {result}"),
        }
    }

    fn assert_process_exited(handle: &OwnedHandle, pid: u32) {
        let result = unsafe { WaitForSingleObject(handle.as_raw_handle() as HANDLE, 5_000) };
        assert_eq!(result, WAIT_OBJECT_0, "process {pid} must have exited before shutdown returns");
    }

    #[test]
    fn windows_process_tree_test_descendant() {
        let Some(pid_file) = std::env::var_os("DBX_PROCESS_TREE_TEST_PID_FILE") else {
            return;
        };
        fs::write(pid_file, std::process::id().to_string()).expect("write descendant PID");
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
}
