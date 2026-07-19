use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::ai_tools::sandbox::resolve_in_workspace;

#[derive(serde::Serialize)]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

/// Run `cmd` via `cmd.exe /C` with `cwd = workspace_root`. Captures stdout/stderr
/// deterministically (not a PTY). Kills the process if it exceeds `timeout_ms`
/// (default 60_000) and reports `timed_out: true`.
#[tauri::command]
pub fn ai_shell_exec(
    workspace_root: String,
    cmd: String,
    timeout_ms: Option<u64>,
) -> Result<ShellExecResult, String> {
    let root = Path::new(&workspace_root);
    // Sandbox only constrains the cwd; the command itself may be anything.
    let _ = resolve_in_workspace(root, "")?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000));

    let mut child = Command::new("cmd.exe")
        .args(["/C", &cmd])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    let start = Instant::now();
    let pid = child.id();

    // Busy-wait with small sleeps; simple and adequate for an AI tool.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("failed to read output: {e}"))?;
                return Ok(ShellExecResult {
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                    exit_code: status.code().unwrap_or(-1),
                    timed_out: false,
                });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = kill_process(pid);
                    let _ = child.wait();
                    return Ok(ShellExecResult {
                        stdout: String::new(),
                        stderr: format!("command timed out after {timeout_ms:?} ms"),
                        exit_code: -1,
                        timed_out: true,
                    });
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("error waiting on child: {e}")),
        }
    }
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    // Use taskkill to also reap child processes spawned by cmd /C.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(windows))]
fn kill_process(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}
