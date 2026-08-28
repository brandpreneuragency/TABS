use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::agent_tools::scope::WorkspaceScopeRegistry;
use crate::ai_tools::cancel::ToolCancelRegistry;

pub const SHELL_DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const SHELL_MAX_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
pub const SHELL_MAX_OUTPUT_BYTES: usize = 65_536;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutputEvent {
    pub cancel_id: String,
    pub stream: String,
    pub chunk: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub truncated: bool,
    pub cancelled: bool,
}

fn clamp_timeout(timeout_ms: Option<u64>) -> Duration {
    let millis = timeout_ms.unwrap_or(SHELL_DEFAULT_TIMEOUT_MS);
    Duration::from_millis(millis.clamp(1, SHELL_MAX_TIMEOUT_MS))
}

pub fn bounded_environment() -> HashMap<String, String> {
    let mut env = HashMap::new();
    const KEYS: &[&str] = if cfg!(windows) {
        &[
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "USERPROFILE",
            "USERNAME",
            "HOMEDRIVE",
            "HOMEPATH",
            "TEMP",
            "TMP",
        ]
    } else {
        &["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"]
    };
    for key in KEYS {
        if let Ok(value) = std::env::var(key) {
            env.insert((*key).to_string(), value);
        }
    }
    env.insert("TERM".to_string(), "dumb".to_string());
    env
}

fn append_bounded(target: &mut String, chunk: &str, max_bytes: usize) -> bool {
    let remaining = max_bytes.saturating_sub(target.len());
    if remaining == 0 {
        return true;
    }
    if chunk.len() > remaining {
        target.push_str(&chunk[..remaining]);
        true
    } else {
        target.push_str(chunk);
        false
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let pgid = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", &pgid]).output();
        thread::sleep(Duration::from_millis(30));
        let _ = Command::new("kill").args(["-KILL", &pgid]).output();
    }
}

pub fn run_bounded_shell(
    command: &str,
    cwd: PathBuf,
    timeout: Duration,
    max_output_bytes: usize,
    cancel: &std::sync::atomic::AtomicBool,
    mut emit: impl FnMut(ShellOutputEvent),
    cancel_id: &str,
) -> Result<ShellExecResult, String> {
    #[cfg(windows)]
    let mut child = {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", command]);
        cmd
    };
    #[cfg(not(windows))]
    let mut child = {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", command]);
        cmd
    };

    child
        .current_dir(&cwd)
        .env_clear()
        .envs(bounded_environment())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        child.process_group(0);
    }

    let mut child = child
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<(String, String)>();

    if let Some(mut pipe) = stdout {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = [0_u8; 1024];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let _ = tx.send((
                    "stdout".to_string(),
                    String::from_utf8_lossy(&buf[..n]).to_string(),
                ));
            }
        });
    }
    if let Some(mut pipe) = stderr {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = [0_u8; 1024];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let _ = tx.send((
                    "stderr".to_string(),
                    String::from_utf8_lossy(&buf[..n]).to_string(),
                ));
            }
        });
    }
    drop(tx);

    let start = Instant::now();
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut truncated = false;
    let mut timed_out = false;
    let mut cancelled = false;
    let mut exit_code = -1;
    loop {
        while let Ok((stream, chunk)) = rx.try_recv() {
            emit(ShellOutputEvent {
                cancel_id: cancel_id.to_string(),
                stream: stream.clone(),
                chunk: chunk.clone(),
                truncated: false,
            });
            let overflow = if stream == "stdout" {
                append_bounded(&mut stdout_buf, &chunk, max_output_bytes)
            } else {
                append_bounded(&mut stderr_buf, &chunk, max_output_bytes)
            };
            truncated = truncated || overflow;
        }
        if ToolCancelRegistry::is_cancelled(cancel) {
            cancelled = true;
            kill_process_tree(pid);
            let _ = child.wait();
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok((stream, chunk)) = rx.recv() {
                    let overflow = if stream == "stdout" {
                        append_bounded(&mut stdout_buf, &chunk, max_output_bytes)
                    } else {
                        append_bounded(&mut stderr_buf, &chunk, max_output_bytes)
                    };
                    truncated = truncated || overflow;
                }
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    kill_process_tree(pid);
                    let _ = child.wait();
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(format!("error waiting on child: {error}")),
        }
    }

    Ok(ShellExecResult {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code,
        timed_out,
        truncated,
        cancelled,
    })
}

/// Run a command with its cwd fixed by an opaque native workspace scope.
#[tauri::command]
pub fn ai_shell_exec(
    app: tauri::AppHandle,
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    cancel: tauri::State<'_, ToolCancelRegistry>,
    scope_id: String,
    cmd: String,
    working_directory: Option<String>,
    timeout_ms: Option<u64>,
    cancel_id: Option<String>,
    max_output_bytes: Option<usize>,
) -> Result<ShellExecResult, String> {
    let root = scopes.root(&scope_id)?;
    let cwd = match working_directory.as_deref() {
        None | Some("") | Some(".") | Some("workspace") => root,
        Some(relative) => {
            let resolved = scopes.resolve(&scope_id, relative)?;
            if !resolved.is_dir() {
                return Err(format!("working directory is not a directory: {relative}"));
            }
            resolved
        }
    };
    let id = cancel_id.clone().unwrap_or_else(|| "shell".to_string());
    let flag = cancel.flag(&id);
    let timeout = clamp_timeout(timeout_ms);
    let max_bytes = max_output_bytes
        .unwrap_or(SHELL_MAX_OUTPUT_BYTES)
        .min(SHELL_MAX_OUTPUT_BYTES);
    let result = run_bounded_shell(
        &cmd,
        cwd,
        timeout,
        max_bytes,
        &flag,
        |event| {
            let _ = app.emit("tabs://shell-output", event);
        },
        &id,
    );
    cancel.finish(&id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn bounded_environment_omits_secrets() {
        std::env::set_var("TABS_TEST_SECRET", "shh");
        let env = bounded_environment();
        assert!(!env.contains_key("TABS_TEST_SECRET"));
        assert!(env.contains_key("PATH") || env.contains_key("Path"));
        std::env::remove_var("TABS_TEST_SECRET");
    }

    #[test]
    fn timeout_kills_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let result = run_bounded_shell(
            "sleep 5",
            dir.path().to_path_buf(),
            Duration::from_millis(200),
            1024,
            &cancel,
            |_| {},
            "timeout",
        )
        .unwrap();
        assert!(result.timed_out);
        assert!(!result.cancelled);
    }

    #[test]
    fn cancellation_kills_the_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let cancel_flag = std::sync::Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let result = run_bounded_shell(
            "sleep 8",
            dir.path().to_path_buf(),
            Duration::from_secs(10),
            1024,
            &cancel,
            |_| {},
            "cancel",
        )
        .unwrap();
        assert!(result.cancelled);
        assert!(!result.timed_out);
    }

    #[test]
    fn output_is_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let result = run_bounded_shell(
            "printf '%400s' '' | tr ' ' a",
            dir.path().to_path_buf(),
            Duration::from_secs(5),
            32,
            &cancel,
            |_| {},
            "trunc",
        )
        .unwrap();
        assert!(result.truncated || result.stdout.len() <= 32);
        assert!(result.stdout.len() <= 32);
    }
}
