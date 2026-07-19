use std::io::{Read, Write};
use std::thread::JoinHandle;

use base64::Engine;
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

/// A single PTY-backed shell session.
pub struct PtySession {
    pub master: Box<dyn MasterPty + Send + 'static>,
    pub child: Box<dyn Child + Send + Sync + 'static>,
    pub writer: Box<dyn Write + Send + 'static>,
    pub reader_thread: Option<JoinHandle<()>>,
}

impl PtySession {
    /// Spawn a new PTY session running `shell` (defaults to `cmd.exe` on Windows)
    /// with the given working directory.
    pub fn spawn(
        app: AppHandle,
        id: String,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = if let Some(s) = shell {
            portable_pty::CommandBuilder::new(s)
        } else {
            // Windows default shell.
            portable_pty::CommandBuilder::new("cmd.exe")
        };
        if let Some(dir) = cwd {
            if !dir.trim().is_empty() {
                cmd.cwd(dir);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;

        // Drop the slave so the PTY is fully owned by the child.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take writer: {e}"))?;

        // Reader thread: emit each completed PTY read immediately. A timer-based
        // batcher cannot live inside this blocking read loop without delaying
        // small prompt/newline updates until more output arrives.
        let reader_app = app.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        emit_output(&reader_app, &id, &buf[..n]);
                    }
                    Err(_) => break,
                }
            }
            let _ = reader_app.emit(
                "terminal://exit",
                serde_json::json!({ "id": id, "exit_code": 0 }),
            );
        });

        Ok(Self {
            master: pair.master,
            child,
            writer,
            reader_thread: Some(reader_thread),
        })
    }

    /// Write raw bytes (decoded from base64 on the frontend) to the PTY stdin.
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer
            .write_all(data)
            .map_err(|e| format!("write failed: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("flush failed: {e}"))
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        drop(self.reader_thread.take());
    }
}

fn emit_output(app: &AppHandle, id: &str, bytes: &[u8]) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let _ = app.emit(
        "terminal://output",
        serde_json::json!({ "id": id, "data": encoded }),
    );
}
