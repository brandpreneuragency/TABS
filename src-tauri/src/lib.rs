// TABS desktop shell.
//
// Phase 2 native features:
//   * Single-instance: a second launch focuses the existing window.
//   * Notification: tauri-plugin-notification (test command below).
//   * Global shortcut Ctrl+Shift+Space: focuses the main window from any app.
//   * Tray icon: Show TABS / Quit menu.
//   * File open: argv is scanned for an existing file path (Open With / double-
//     click). Path is stored as pending state and emitted as `tabs://open-file`
//     so the frontend can open it even if the listener attaches late.
use std::sync::Mutex;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub mod ai_tools;
mod commands;
mod terminal;
mod tray;

/// Path from OS "Open With" / file association that the frontend has not yet
/// consumed. Survives the race where setup emits before the webview listens.
struct PendingOpenFile(Mutex<Option<String>>);

/// Pick the first argv entry that looks like a real file to open.
/// Skips flags (`-…`) and the executable path itself.
fn extract_open_file_path(args: impl IntoIterator<Item = String>) -> Option<String> {
    for arg in args {
        let trimmed = arg.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let p = std::path::Path::new(trimmed);
        // Windows "Open with" passes the absolute path; only accept existing files.
        if p.is_file() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn queue_open_file(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingOpenFile>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(path.clone());
        }
    }
    let _ = app.emit("tabs://open-file", path);
}

// Convenience command to exercise the notification plugin from the webview
// devtools console:
//   await window.__TAURI__.core.invoke('test_notification')
#[tauri::command]
fn test_notification(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("TABS")
        .body("Phase 2 notification test")
        .show()
        .map_err(|e| e.to_string())
}

/// Frontend calls this on mount to recover a cold-start Open With path that
/// may have been emitted before the event listener was registered.
#[tauri::command]
fn take_pending_open_file(state: tauri::State<'_, PendingOpenFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance is release-only. If it is also enabled in debug, an
    // already-running installed TABS (often hidden in the tray after close)
    // causes `npm run tauri:dev` to start and immediately exit — looking
    // like the dev command "keeps quitting".
    let builder = tauri::Builder::default();

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // Second launch focuses the existing window instead of starting another.
        focus_main_window(app);
        // Forward Open With / double-click path from the second process.
        // argv[0] is the executable; remaining args may include the file path.
        if let Some(path) = extract_open_file_path(argv.into_iter().skip(1)) {
            queue_open_file(app, path);
        }
    }));

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(terminal::TerminalRegistry::new())
        .manage(PendingOpenFile(Mutex::new(None)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space)
                    {
                        focus_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            test_notification,
            take_pending_open_file,
            commands::secrets::secret_get,
            commands::secrets::secret_set,
            commands::secrets::secret_delete,
            commands::search::search_web,
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_list,
            commands::terminal::home_dir,
            commands::ai_tools::shell::ai_shell_exec,
            commands::ai_tools::fs_ops::ai_file_read,
            commands::ai_tools::fs_ops::ai_file_write,
            commands::ai_tools::fs_ops::ai_file_edit,
            commands::ai_tools::search::ai_glob,
            commands::ai_tools::search::ai_grep
        ])
        .setup(|app| {
            // Intercept the main window's close button: instead of quitting
            // the app, hide the window so the tray icon remains usable.
            // The user can quit from the tray's "Quit" menu item, or by
            // pressing Ctrl+Shift+Space (which will refocus the hidden
            // window if it's still running).
            if let Some(window) = app.get_webview_window("main") {
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            // The main window is now created with `visible: true` in
            // tauri.conf.json so it shows up reliably on first launch.
            // We still call `show()` + `set_focus()` here as a belt-and-
            // braces guarantee: this runs after WebView2 is initialized
            // and the window is fully ready, so the show will actually
            // take effect (the old `visible: false` + immediate show()
            // had a race that left the window invisible on some machines).
            focus_main_window(app.handle());

            // Register Ctrl+Shift+Space as the "focus TABS" global hotkey.
            let shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::Space,
            );
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("[TABS] Failed to register Ctrl+Shift+Space: {e}");
            }

            // Build the tray icon.
            tray::build(app.handle())?;

            // Cold-start Open With / file association: store + emit so the
            // frontend can open the file after it mounts (take_pending_open_file
            // covers the race if the event fires too early).
            if let Some(path) = extract_open_file_path(std::env::args().skip(1)) {
                queue_open_file(app.handle(), path);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
