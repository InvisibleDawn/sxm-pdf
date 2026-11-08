//! Capture d'écran (portail Linux, outil natif macOS, écran sous la souris sous Windows).
#![allow(unused_imports)]
use crate::*;

/// Capture d'écran. Sous Linux (Wayland/GNOME) : passe par le portail système,
/// qui affiche son propre sélecteur de zone. macOS : outil de sélection natif (screencapture -i).
/// Windows : capture de l'écran principal, le recadrage se fait ensuite dans l'éditeur.
#[tauri::command]
pub(crate) async fn capture_screen(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let _ = &app;
        use ashpd::desktop::screenshot::Screenshot;
        let resp = Screenshot::request()
            .interactive(true)
            .modal(true)
            .send()
            .await
            .map_err(|e| format!("Portail de capture indisponible : {e}"))?
            .response()
            .map_err(|_| "Capture annulée".to_string())?;
        let uri = resp.uri().to_string();
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        return Ok(urlencoding::decode(path).map(|c| c.into_owned()).unwrap_or(path.to_string()));
    }
    #[cfg(not(target_os = "linux"))]
    {
        // On masque SXM PDF le temps de la capture (côté Rust : aucune permission JS requise),
        // et on la réaffiche quoi qu'il arrive.
        let win = app.get_webview_window("main");
        if let Some(w) = &win {
            let _ = w.hide();
        }
        tokio_sleep_ms(400).await;
        let res = tauri::async_runtime::spawn_blocking(grab_screen)
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
        if let Some(w) = &win {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        res
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn tokio_sleep_ms(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn capture_temp_path() -> PathBuf {
    app_temp_dir().join(format!("capture-{}.png", unique_suffix()))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub(crate) fn CGPreflightScreenCaptureAccess() -> bool;
    pub(crate) fn CGRequestScreenCaptureAccess() -> bool;
}

/// macOS : outil de sélection natif (comme Cmd+Maj+4). Échap = capture annulée.
#[cfg(target_os = "macos")]
pub(crate) fn grab_screen() -> Result<String, String> {
    // Sans l'autorisation « Enregistrement de l'écran », macOS ne capture que le fond d'écran.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        unsafe { CGRequestScreenCaptureAccess() };
        return Err("macOS doit autoriser SXM PDF à capturer l'écran : Réglages Système > Confidentialité et sécurité > Enregistrement de l'écran et de l'audio système > activez SXM PDF, puis quittez et rouvrez l'application.".into());
    }
    let path = capture_temp_path();
    let st = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x"])
        .arg(&path)
        .status()
        .map_err(|e| format!("screencapture introuvable : {e}"))?;
    if !st.success() || !path.exists() {
        return Err("Capture annulée".into());
    }
    Ok(path.to_string_lossy().to_string())
}

/// Windows : capture de l'écran principal, le recadrage se fait dans l'éditeur.
#[cfg(all(not(target_os = "linux"), not(target_os = "macos")))]
pub(crate) fn grab_screen() -> Result<String, String> {
    // Écran où se trouve la souris (plusieurs écrans), sinon l'écran principal
    #[repr(C)]
    struct Point { x: i32, y: i32 }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
    }
    let mut pt = Point { x: 0, y: 0 };
    let under_mouse = if unsafe { GetCursorPos(&mut pt) } != 0 { xcap::Monitor::from_point(pt.x, pt.y).ok() } else { None };
    let mon = match under_mouse {
        Some(m) => m,
        None => xcap::Monitor::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .ok_or("Aucun écran trouvé")?,
    };
    let img = mon.capture_image().map_err(|e| e.to_string())?;
    let path = capture_temp_path();
    img.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
