//! Intégration au système : fichiers à ouvrir, impression, messagerie, liens, épinglage, menu macOS.
#![allow(unused_imports)]
use crate::*;

/// Fichiers reçus de macOS (double-clic, « Ouvrir avec ») avant que l'interface soit prête.
pub(crate) static PENDING_OPEN: std::sync::Mutex<(bool, Vec<String>)> = std::sync::Mutex::new((false, Vec::new()));

/// Fichier passé en argument au lancement (ouvrir avec…) ou drapeau --capture.
/// Sous macOS, les fichiers arrivent par un événement : ceux reçus avant l'interface sont ajoutés ici.
#[tauri::command]
pub(crate) fn startup_args() -> Vec<String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut p = PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner());
    p.0 = true; // interface prête : les prochains fichiers sont envoyés directement
    args.append(&mut p.1);
    args
}

/// macOS : fichiers à ouvrir reçus du Finder (événement « Opened »).
#[cfg(target_os = "macos")]
pub(crate) fn files_opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
    if paths.is_empty() {
        return;
    }
    let mut p = PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner());
    if p.0 {
        drop(p);
        let _ = app.emit("sxm-args", paths);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    } else {
        p.1.extend(paths);
    }
}

/// Impression native de la fenêtre (macOS : WKWebView ignore window.print()).
#[tauri::command]
pub(crate) fn print_window(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("Fenêtre introuvable")?;
    w.print().map_err(|e| e.to_string())
}

/// Ouvre un nouveau message dans la messagerie par défaut avec le PDF en pièce jointe.
#[tauri::command]
pub(crate) async fn send_mail(path: String, subject: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || send_mail_impl(&path, &subject))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
pub(crate) fn send_mail_impl(path: &str, subject: &str) -> Result<String, String> {
    // xdg-email gère Thunderbird, Evolution, Geary… avec pièce jointe
    let st = Command::new("xdg-email")
        .args(["--subject", subject, "--attach", path])
        .status()
        .map_err(|e| format!("xdg-email introuvable : {e}"))?;
    if st.success() {
        Ok("ok".into())
    } else {
        reveal(path);
        Err("Aucune messagerie compatible trouvée. Le fichier est affiché dans son dossier : glissez-le dans votre mail.".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn send_mail_impl(path: &str, _subject: &str) -> Result<String, String> {
    // Messagerie choisie par l'utilisateur (gestionnaire « mailto »). Apple Mail et Outlook créent
    // un nouveau message avec la pièce jointe quand on leur ouvre un fichier.
    let handler = mac_mail_handler().unwrap_or_else(|| "com.apple.mail".into());
    let supported = ["com.apple.mail", "com.microsoft.outlook"];
    if supported.contains(&handler.to_lowercase().as_str()) {
        let st = Command::new("open").args(["-b", &handler, path]).status().map_err(|e| e.to_string())?;
        if st.success() {
            return Ok("ok".into());
        }
    }
    reveal(path);
    Err("Votre messagerie ne permet pas l'ajout automatique de pièce jointe. Le fichier est sélectionné dans le Finder : glissez-le dans votre mail.".into())
}

/// Identifiant de l'application de messagerie par défaut sur macOS (None = Apple Mail par défaut).
#[cfg(target_os = "macos")]
pub(crate) fn mac_mail_handler() -> Option<String> {
    let out = Command::new("defaults")
        .args(["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"])
        .output()
        .ok()?;
    parse_mailto_handler(&String::from_utf8_lossy(&out.stdout))
}

/// Cherche, dans la sortie de `defaults read … LSHandlers`, l'application associée à « mailto ».
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_mailto_handler(text: &str) -> Option<String> {
    for block in text.split('}') {
        if block.contains("LSHandlerURLScheme = mailto") {
            for line in block.lines() {
                let l = line.trim();
                if let Some(v) = l.strip_prefix("LSHandlerRoleAll = ") {
                    return Some(v.trim_end_matches(';').trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
pub(crate) fn send_mail_impl(path: &str, subject: &str) -> Result<String, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct MapiFileDescW {
        ul_reserved: u32,
        fl_flags: u32,
        n_position: u32,
        lpsz_path_name: *const u16,
        lpsz_file_name: *const u16,
        lp_file_type: *mut c_void,
    }
    #[repr(C)]
    struct MapiMessageW {
        ul_reserved: u32,
        lpsz_subject: *const u16,
        lpsz_note_text: *const u16,
        lpsz_message_type: *const u16,
        lpsz_date_received: *const u16,
        lpsz_conversation_id: *const u16,
        fl_flags: u32,
        lp_originator: *mut c_void,
        n_recip_count: u32,
        lp_recips: *mut c_void,
        n_file_count: u32,
        lp_files: *mut MapiFileDescW,
    }
    type SendMailW = unsafe extern "system" fn(usize, usize, *mut MapiMessageW, u32, u32) -> u32;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let w_path = wide(path);
    let w_name = wide(Path::new(path).file_name().unwrap_or_default().to_string_lossy().as_ref());
    let w_subject = wide(subject);

    let result = unsafe {
        let lib = libloading::Library::new("MAPI32.dll").map_err(|e| e.to_string());
        match lib {
            Ok(lib) => match lib.get::<SendMailW>(b"MAPISendMailW\0") {
                Ok(f) => {
                    let mut file = MapiFileDescW {
                        ul_reserved: 0,
                        fl_flags: 0,
                        n_position: u32::MAX,
                        lpsz_path_name: w_path.as_ptr(),
                        lpsz_file_name: w_name.as_ptr(),
                        lp_file_type: std::ptr::null_mut(),
                    };
                    let mut msg = MapiMessageW {
                        ul_reserved: 0,
                        lpsz_subject: w_subject.as_ptr(),
                        lpsz_note_text: std::ptr::null(),
                        lpsz_message_type: std::ptr::null(),
                        lpsz_date_received: std::ptr::null(),
                        lpsz_conversation_id: std::ptr::null(),
                        fl_flags: 0,
                        lp_originator: std::ptr::null_mut(),
                        n_recip_count: 0,
                        lp_recips: std::ptr::null_mut(),
                        n_file_count: 1,
                        lp_files: &mut file,
                    };
                    // MAPI_LOGON_UI (0x1) | MAPI_DIALOG (0x8)
                    let rc = f(0, 0, &mut msg, 0x1 | 0x8, 0);
                    if rc == 0 || rc == 1 { Ok(()) } else { Err(format!("MAPI {rc}")) } // 1 = annulé par l'utilisateur
                }
                Err(e) => Err(e.to_string()),
            },
            Err(e) => Err(e),
        }
    };
    match result {
        Ok(()) => Ok("ok".into()),
        Err(_) => {
            // Messagerie sans MAPI (nouvel Outlook, Mail de Windows, webmail) : on montre le fichier
            reveal(path);
            Err("Votre messagerie ne permet pas l'ajout automatique de pièce jointe. Le fichier est sélectionné dans l'Explorateur : glissez-le dans votre mail.".into())
        }
    }
}

/// Ouvre un lien d'un PDF dans le navigateur ou la messagerie par défaut (http, https, mailto seulement).
#[tauri::command]
pub(crate) fn open_external(url: String) -> Result<(), String> {
    if !is_safe_url(&url) {
        return Err("Lien non pris en charge.".into());
    }
    #[cfg(windows)]
    let r = Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let r = Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

pub(crate) fn is_safe_url(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    (l.starts_with("https://") || l.starts_with("http://") || l.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control() || c == '"' || c == ' ')
        && url.len() < 4096
}

/// Affiche le fichier dans le gestionnaire de fichiers.
pub(crate) fn reveal(path: &str) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(format!("/select,{path}")).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").args(["-R", path]).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open")
        .arg(Path::new(path).parent().unwrap_or(Path::new("/")))
        .spawn();
}

/// Indique quels outils externes sont présents (LibreOffice, qpdf).
#[tauri::command]
pub(crate) fn check_tools(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "libreoffice": find_soffice(&app).is_some(), "qpdf": find_qpdf(&app).is_some() })
}

/// Nom du fichier .desktop installé par le paquet (ex. « SXM PDF.desktop »).
#[cfg(target_os = "linux")]
pub(crate) fn find_desktop_id() -> Result<String, String> {
    let home_apps = std::env::var("HOME").map(|h| format!("{h}/.local/share/applications")).unwrap_or_default();
    let dirs = ["/usr/share/applications", "/usr/local/share/applications", home_apps.as_str()];
    dirs.iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .flatten()
        .find(|e| {
            e.path().extension().map(|x| x == "desktop").unwrap_or(false)
                && std::fs::read_to_string(e.path())
                    .map(|c| c.contains("Exec=sxm-pdf"))
                    .unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .ok_or_else(|| "Fichier de lancement introuvable : installez d'abord le paquet .rpm.".to_string())
}

/// Épingle SXM PDF dans la barre des favoris (GNOME) ou le Dock (macOS), avec l'accord de l'utilisateur.
/// Renvoie "ok", "deja" ou une erreur ; sous Windows, "windows" (épinglage automatique interdit par le système).
#[tauri::command]
pub(crate) fn pin_app() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let id = find_desktop_id()?;
        let out = Command::new("gsettings")
            .args(["get", "org.gnome.shell", "favorite-apps"])
            .output()
            .map_err(|_| "Bureau non compatible : faites un clic droit sur l'icône de SXM PDF puis « Ajouter aux favoris ».".to_string())?;
        if !out.status.success() {
            return Err("Bureau non compatible : faites un clic droit sur l'icône de SXM PDF puis « Ajouter aux favoris ».".into());
        }
        let cur = String::from_utf8_lossy(&out.stdout).to_string();
        // Format : ['a.desktop', 'b.desktop'] ou @as []
        let mut apps: Vec<String> = cur
            .trim()
            .trim_start_matches("@as")
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if apps.iter().any(|a| a == &id) {
            return Ok("deja".into());
        }
        apps.push(id);
        let list = format!(
            "[{}]",
            apps.iter().map(|a| format!("'{}'", a.replace('\'', ""))).collect::<Vec<_>>().join(", ")
        );
        let st = Command::new("gsettings")
            .args(["set", "org.gnome.shell", "favorite-apps", &list])
            .status()
            .map_err(|e| e.to_string())?;
        return if st.success() { Ok("ok".into()) } else { Err("gsettings a échoué".into()) };
    }
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let app = exe
            .ancestors()
            .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
            .ok_or("Lancez SXM PDF depuis le dossier Applications pour l'ajouter au Dock.")?
            .to_string_lossy()
            .to_string();
        let cur = Command::new("defaults")
            .args(["read", "com.apple.dock", "persistent-apps"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        if cur.contains(&app) || cur.contains(&app.replace(' ', "%20")) {
            return Ok("deja".into());
        }
        let xml = app.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let tile = format!(
            "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>{xml}</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
        );
        Command::new("defaults")
            .args(["write", "com.apple.dock", "persistent-apps", "-array-add", &tile])
            .status()
            .map_err(|e| e.to_string())?;
        let _ = Command::new("killall").arg("Dock").status();
        return Ok("ok".into());
    }
    #[cfg(windows)]
    {
        return Ok("windows".into());
    }
}

/// Définit SXM PDF comme lecteur PDF par défaut — uniquement à la demande de l'utilisateur.
#[tauri::command]
pub(crate) fn set_default_pdf() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let desktop = find_desktop_id()?;
        let st = Command::new("xdg-mime")
            .args(["default", &desktop, "application/pdf"])
            .status()
            .map_err(|e| e.to_string())?;
        return if st.success() { Ok(()) } else { Err("xdg-mime a échoué".into()) };
    }
    #[cfg(target_os = "windows")]
    {
        // Windows impose que l'utilisateur confirme lui-même dans les Paramètres.
        Command::new("cmd")
            .args(["/C", "start", "ms-settings:defaultapps"])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Err("Choisissez SXM PDF pour « .pdf » dans la fenêtre Paramètres qui vient de s'ouvrir.".into());
    }
    #[cfg(target_os = "macos")]
    {
        return Err("Sur macOS : clic droit sur un PDF > Lire les informations > Ouvrir avec : SXM PDF > Tout modifier.".into());
    }
}

/// macOS : menu standard (Édition, Fenêtre…) dont l'élément « Quitter » est remplacé par le nôtre,
/// sinon Cmd+Q fermerait l'application sans proposer d'enregistrer les documents modifiés.
#[cfg(target_os = "macos")]
pub(crate) fn mac_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app.handle())?;
    if let Some(MenuItemKind::Submenu(appmenu)) = menu.items()?.into_iter().next() {
        for it in appmenu.items()? {
            if let MenuItemKind::Predefined(p) = &it {
                let t = p.text().unwrap_or_default();
                if t.starts_with("Quit") || t.starts_with("Quitter") {
                    appmenu.remove(p)?;
                }
            }
        }
        let quit = MenuItem::with_id(app, "sxm-quit", "Quitter SXM PDF", true, Some("CmdOrCtrl+Q"))?;
        appmenu.append(&quit)?;
    }
    app.set_menu(menu)?;
    Ok(())
}
