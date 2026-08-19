use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::agent_tools::scope::WorkspaceScopeRegistry;

#[derive(serde::Serialize)]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

/// Run a command with its cwd fixed by an opaque native workspace scope.
#[tauri::command]
pub fn ai_shell_exec(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    cmd: String,
    timeout_ms: Option<u64>,
) -> Result<ShellExecResult, String> {
    let root = scopes.root(&scope_id)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000));

    #[cfg(windows)]
    let mut child = Command::new("cmd.exe")
        .args(["/C", &cmd])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    #[cfg(not(windows))]
    let mut child = Command::new("sh")
        .args(["-c", &cmd])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    let start = Instant::now();
    let pid = child.id();
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
                    kill_process(pid);
                    let _ = child.wait();
                    return Ok(ShellExecResult {
                        stdout: String::new(),
                        stderr: format!("command timed out after {} ms", timeout.as_millis()),
                        exit_code: -1,
                        timed_out: true,
                    });
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("error waiting on child: {error}")),
        }
    }
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(windows))]
fn kill_process(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
}
