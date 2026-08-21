// Desktop lifecycle gate: shutdown, update restart, and run notifications.
//
// Tray Quit emits `tabs://shutdown-requested` and must not call `app.exit(0)`.
// `complete_shutdown` and update installation require a prepared request token.
// Cancelling an update releases the barrier. Notifications never include
// sensitive record data.

use std::sync::Mutex;

use rand::RngCore;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleKind {
    Shutdown,
    Restart,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingRequest {
    request_id: String,
    kind: LifecycleKind,
    prepared: bool,
}

struct Inner {
    pending: Option<PendingRequest>,
    exit_requested: bool,
}

/// Process-local authority for shutdown and update tokens.
#[derive(Default)]
pub struct LifecycleGate {
    inner: Mutex<Inner>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            pending: None,
            exit_requested: false,
        }
    }
}

impl LifecycleGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request(&self, kind: LifecycleKind) -> Result<String, String> {
        let mut inner = self.lock()?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.prepared)
        {
            return Err("LifecycleRequestInProgress".to_string());
        }
        let request_id = new_request_id();
        inner.pending = Some(PendingRequest {
            request_id: request_id.clone(),
            kind,
            prepared: false,
        });
        inner.exit_requested = false;
        Ok(request_id)
    }

    pub fn prepare(&self, request_id: &str, kind: LifecycleKind) -> Result<String, String> {
        let mut inner = self.lock()?;
        match inner.pending.as_mut() {
            Some(pending) if pending.request_id == request_id && pending.kind == kind => {
                pending.prepared = true;
                Ok(pending.request_id.clone())
            }
            Some(_) => Err("LifecycleRequestMismatch".to_string()),
            None => Err("LifecycleRequestMissing".to_string()),
        }
    }

    pub fn authorize_complete_shutdown(&self, request_token: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        match inner.pending.as_ref() {
            Some(pending)
                if pending.request_id == request_token
                    && pending.prepared
                    && pending.kind == LifecycleKind::Shutdown =>
            {
                inner.pending = None;
                inner.exit_requested = true;
                Ok(())
            }
            _ => Err("LifecycleTokenInvalid".to_string()),
        }
    }

    pub fn authorize_install_update(&self, request_token: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        match inner.pending.as_ref() {
            Some(pending)
                if pending.request_id == request_token
                    && pending.prepared
                    && pending.kind == LifecycleKind::Restart =>
            {
                inner.pending = None;
                Ok(())
            }
            _ => Err("LifecycleTokenInvalid".to_string()),
        }
    }

    pub fn cancel(&self, request_token: &str) -> Result<(), String> {
        let mut inner = self.lock()?;
        match inner.pending.as_ref() {
            Some(pending) if pending.request_id == request_token => {
                inner.pending = None;
                inner.exit_requested = false;
                Ok(())
            }
            _ => Err("LifecycleTokenInvalid".to_string()),
        }
    }

    #[cfg(test)]
    pub fn exit_requested(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.exit_requested)
            .unwrap_or(false)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "LifecycleStateUnavailable".to_string())
    }
}

fn new_request_id() -> String {
    let mut random = [0_u8; 16];
    rand::rng().fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// OS notification copy. Bodies must stay generic — no record, goal, or credential data.
pub fn notification_copy(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind {
        "approval" => Ok(("TABS", "A run is waiting for approval.")),
        "review" => Ok(("TABS", "A run needs review.")),
        "completed" => Ok(("TABS", "A run completed.")),
        "failed" => Ok(("TABS", "A run failed.")),
        _ => Err("LifecycleNotificationKindInvalid".to_string()),
    }
}

pub fn begin_shutdown_request(app: &AppHandle) -> Option<String> {
    match app
        .state::<LifecycleGate>()
        .request(LifecycleKind::Shutdown)
    {
        Ok(request_id) => Some(request_id),
        Err(error) => {
            eprintln!("[TABS] shutdown request rejected: {error}");
            None
        }
    }
}

#[tauri::command]
pub fn request_restart(gate: State<'_, LifecycleGate>) -> Result<String, String> {
    gate.request(LifecycleKind::Restart)
}

#[tauri::command]
pub fn prepare_shutdown(
    gate: State<'_, LifecycleGate>,
    request_id: String,
) -> Result<String, String> {
    gate.prepare(&request_id, LifecycleKind::Shutdown)
}

#[tauri::command]
pub fn prepare_for_restart(
    gate: State<'_, LifecycleGate>,
    request_id: String,
) -> Result<String, String> {
    gate.prepare(&request_id, LifecycleKind::Restart)
}

#[tauri::command]
pub fn complete_shutdown(app: AppHandle, request_token: String) -> Result<(), String> {
    app.state::<LifecycleGate>()
        .authorize_complete_shutdown(&request_token)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn install_update(gate: State<'_, LifecycleGate>, request_token: String) -> Result<(), String> {
    gate.authorize_install_update(&request_token)
}

#[tauri::command]
pub fn cancel_update(gate: State<'_, LifecycleGate>, request_token: String) -> Result<(), String> {
    gate.cancel(&request_token)
}

#[tauri::command]
pub fn notify_run_event(app: AppHandle, kind: String) -> Result<(), String> {
    let (title, body) = notification_copy(&kind)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_shutdown_requires_prepared_token() {
        let gate = LifecycleGate::new();
        let request_id = gate.request(LifecycleKind::Shutdown).unwrap();
        assert_eq!(
            gate.authorize_complete_shutdown(&request_id),
            Err("LifecycleTokenInvalid".to_string())
        );
        assert!(!gate.exit_requested());

        let token = gate.prepare(&request_id, LifecycleKind::Shutdown).unwrap();
        assert_eq!(token, request_id);
        gate.authorize_complete_shutdown(&token).unwrap();
        assert!(gate.exit_requested());
    }

    #[test]
    fn unresponsive_client_does_not_exit() {
        let gate = LifecycleGate::new();
        let request_id = gate.request(LifecycleKind::Shutdown).unwrap();
        assert_eq!(
            gate.authorize_complete_shutdown("not-the-token"),
            Err("LifecycleTokenInvalid".to_string())
        );
        assert_eq!(
            gate.authorize_complete_shutdown(&request_id),
            Err("LifecycleTokenInvalid".to_string())
        );
        assert!(!gate.exit_requested());
    }

    #[test]
    fn install_update_requires_prepared_restart_token() {
        let gate = LifecycleGate::new();
        let shutdown_id = gate.request(LifecycleKind::Shutdown).unwrap();
        gate.prepare(&shutdown_id, LifecycleKind::Shutdown).unwrap();
        assert_eq!(
            gate.authorize_install_update(&shutdown_id),
            Err("LifecycleTokenInvalid".to_string())
        );

        let restart_gate = LifecycleGate::new();
        let restart_id = restart_gate.request(LifecycleKind::Restart).unwrap();
        assert_eq!(
            restart_gate.authorize_install_update(&restart_id),
            Err("LifecycleTokenInvalid".to_string())
        );
        let token = restart_gate
            .prepare(&restart_id, LifecycleKind::Restart)
            .unwrap();
        restart_gate.authorize_install_update(&token).unwrap();
        assert_eq!(
            restart_gate.authorize_install_update(&token),
            Err("LifecycleTokenInvalid".to_string())
        );
    }

    #[test]
    fn cancel_update_releases_the_barrier() {
        let gate = LifecycleGate::new();
        let request_id = gate.request(LifecycleKind::Restart).unwrap();
        gate.prepare(&request_id, LifecycleKind::Restart).unwrap();
        gate.cancel(&request_id).unwrap();
        assert_eq!(
            gate.authorize_install_update(&request_id),
            Err("LifecycleTokenInvalid".to_string())
        );
        assert!(!gate.exit_requested());
    }

    #[test]
    fn request_ids_are_unique() {
        let gate = LifecycleGate::new();
        let first = gate.request(LifecycleKind::Shutdown).unwrap();
        let second = gate.request(LifecycleKind::Shutdown).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 32);
    }

    #[test]
    fn prepared_request_blocks_a_replacement() {
        let gate = LifecycleGate::new();
        let request_id = gate.request(LifecycleKind::Shutdown).unwrap();
        gate.prepare(&request_id, LifecycleKind::Shutdown).unwrap();
        assert_eq!(
            gate.request(LifecycleKind::Shutdown),
            Err("LifecycleRequestInProgress".to_string())
        );
    }

    #[test]
    fn notification_copy_has_no_sensitive_record_data() {
        for kind in ["approval", "review", "completed", "failed"] {
            let (title, body) = notification_copy(kind).unwrap();
            assert_eq!(title, "TABS");
            let lowered = body.to_ascii_lowercase();
            for forbidden in [
                "goal",
                "email",
                "token",
                "password",
                "credential",
                "record",
                "lead",
                "submission",
                "api_key",
            ] {
                assert!(
                    !lowered.contains(forbidden),
                    "{kind} body leaked '{forbidden}': {body}"
                );
            }
        }
        assert_eq!(
            notification_copy("secret-dump"),
            Err("LifecycleNotificationKindInvalid".to_string())
        );
    }
}
