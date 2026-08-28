// Tray icon: right-click menu with "Show TABS", "Test Notification", and
// "Quit". Left-click focuses the main window.
//
// We load the icon from disk rather than using `default_window_icon()` for
// two reasons:
//   1. The system tray renders at 16x16 (or 32x32 on HiDPI). The default
//      icon embedded in tauri.conf.json is the bundle icon, which is sized
//      for installers and gets upscaled/downscaled unpredictably — Windows
//      will sometimes draw a blank square or fail on hover as a result.
//   2. The tray expects an opaque or pre-multiplied alpha BGRA image. PNGs
//      embedded via the build script don't always satisfy that, and
//      `Image::from_path` reads a properly-formatted raw image from disk
//      that the OS can render directly.
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;

pub fn build(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show TABS", true, None::<&str>)?;
    let test = MenuItem::with_id(
        app,
        "test_notification",
        "Test Notification",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &test, &quit])?;

    // Prefer the dedicated tray-friendly icon if present, otherwise fall
    // back to the default window icon. Both paths go through Image::from_path
    // / clone which produce a properly-formed BGRA bitmap the Windows tray
    // can render without artifacts.
    let icon: Image<'static> = load_tray_icon(app).unwrap_or_else(|| {
        app.default_window_icon()
            .map(|img| img.clone().to_owned())
            .expect("no icon available for tray")
    });

    TrayIconBuilder::with_id("tabs-tray")
        .icon(icon)
        .tooltip("TABS")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "test_notification" => {
                if let Err(e) = app
                    .notification()
                    .builder()
                    .title("TABS")
                    .body("Phase 2 notification test")
                    .show()
                {
                    eprintln!("[TABS] notification failed: {e}");
                }
            }
            "quit" => {
                // Plan 25.4: emit a shutdown request. Do not call app.exit(0).
                show_main(app);
                if let Some(request_id) = crate::commands::lifecycle::begin_shutdown_request(app) {
                    if let Err(error) = app.emit("tabs://shutdown-requested", request_id) {
                        eprintln!("[TABS] failed to emit tabs://shutdown-requested: {error}");
                    }
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Bring the window back if it was minimized, then show + focus.
        // `unminimize` is a no-op if the window is not minimized, so it's
        // safe to call unconditionally.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn load_tray_icon(app: &tauri::AppHandle) -> Option<Image<'static>> {
    // The build embeds icons under src-tauri/icons/. Look for a dedicated
    // tray icon first, then the 32x32 / 128x128 fallbacks. We resolve
    // each name against the resource dir (production) and the cwd (dev).
    let candidates = [
        "tray-icon.png",
        "tray.png",
        "32x32.png",
        "128x128.png",
        "icon.png",
    ];
    let resource_dir = app.path().resource_dir().ok();
    for name in candidates {
        if let Some(dir) = &resource_dir {
            if let Ok(img) = Image::from_path(dir.join(name)) {
                return Some(img);
            }
        }
        if let Ok(img) = Image::from_path(name) {
            return Some(img);
        }
    }
    None
}
