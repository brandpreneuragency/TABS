// Secure secret storage backed by the OS keychain
// (Windows Credential Manager / macOS Keychain / Linux Secret Service).
//
// Frontend calls these via `invoke('secret_get' | 'secret_set' | 'secret_delete', ...)`. All
// entries share a single service identifier so they are scoped together; the
// `account` parameter is the per-secret key (e.g. "anthropic_api_key").
//
// We use the `keyring` crate directly rather than a Tauri plugin wrapper
// because there is no Tauri 2-compatible `tauri-plugin-keyring` on crates.io
// (the 0.1.0 release targets Tauri 1). The `keyring` crate is cross-platform
// and works fine inside a Tauri 2 command.
use keyring::Entry;

const SERVICE: &str = "com.tabs.app";

#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// This exercises Windows Credential Manager. Headless Linux CI does not have a
// Secret Service session, so it cannot provide the same integration boundary.
#[cfg(all(test, windows))]
mod tests {
    use super::{secret_delete, secret_get, secret_set};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn secret_commands_round_trip_across_entries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let account = format!("tabs-keyring-test-{}-{nonce}", std::process::id());
        let value = "credential-round-trip".to_string();

        secret_set(account.clone(), value.clone()).expect("secret should be written");
        assert_eq!(
            secret_get(account.clone()).expect("secret should be readable"),
            Some(value),
        );
        secret_delete(account.clone()).expect("secret should be deleted");
        assert_eq!(
            secret_get(account).expect("deleted secret lookup should succeed"),
            None,
        );
    }
}
