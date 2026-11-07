#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager};

/// Fichiers reçus de macOS (double-clic, « Ouvrir avec ») avant que l'interface soit prête.
static PENDING_OPEN: std::sync::Mutex<(bool, Vec<String>)> = std::sync::Mutex::new((false, Vec::new()));

/// Fichier passé en argument au lancement (ouvrir avec…) ou drapeau --capture.
/// Sous macOS, les fichiers arrivent par un événement : ceux reçus avant l'interface sont ajoutés ici.
#[tauri::command]
fn startup_args() -> Vec<String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut p = PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner());
    p.0 = true; // interface prête : les prochains fichiers sont envoyés directement
    args.append(&mut p.1);
    args
}

/// macOS : fichiers à ouvrir reçus du Finder (événement « Opened »).
#[cfg(target_os = "macos")]
fn files_opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
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

/// Lit un fichier et le renvoie en binaire brut (rapide pour les gros PDF).
#[tauri::command]
fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("Lecture impossible de {path} : {e}"))
}

/// Écrit un fichier ; le corps de la requête est le contenu binaire.
/// Écriture sûre : fichier temporaire dans le même dossier, forcé sur le disque, puis remplacement
/// atomique. Une coupure ou un disque plein pendant l'écriture laisse l'ancien fichier intact.
#[tauri::command]
fn write_bytes(request: tauri::ipc::Request) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|s| urlencode_decode(s))
        .ok_or("Chemin manquant")?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Contenu invalide".into());
    };
    write_file_safely(Path::new(&path), data).map_err(|e| format!("Écriture impossible de {path} : {e}"))
}

/// Fichier temporaire voisin (même dossier, donc même disque : le remplacement est atomique).
fn sibling_tmp(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.sxm-tmp"))
}

fn write_file_safely(path: &Path, data: &[u8]) -> Result<(), String> {
    atomic_write(path, &sibling_tmp(path), data, &replace_file)
}

fn urlencode_decode(s: &str) -> String {
    #[cfg(target_os = "linux")]
    {
        urlencoding::decode(s).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Décodage %XX minimal pour Windows/macOS
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

/// Cherche LibreOffice : d'abord la copie embarquée, puis le système.
fn find_soffice(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for rel in [
            "libreoffice/program/soffice.exe",
            "libreoffice/program/soffice",
            "LibreOffice.app/Contents/MacOS/soffice",
        ] {
            let p = res.join(rel);
            if p.exists() {
                return Some(p);
            }
        }
    }
    let candidates: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        ]
    } else if cfg!(target_os = "macos") {
        &["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    } else {
        &["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/lib64/libreoffice/program/soffice"]
    };
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
}

/// Une conversion LibreOffice à la fois : le profil LibreOffice ne supporte pas deux instances.
static CONVERT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Durée maximale d'une conversion : au-delà, LibreOffice est arrêté.
const CONVERT_TIMEOUT_S: u64 = 120;

/// Conversion hors ligne via LibreOffice (Office → PDF, ou PDF → Word avec infilter).
/// Chaque conversion écrit dans son propre dossier : un ancien résultat portant le même nom
/// ne peut jamais être ouvert à la place du bon document.
#[tauri::command]
async fn office_convert(
    app: tauri::AppHandle,
    path: String,
    to: String,
    infilter: Option<String>,
) -> Result<String, String> {
    let soffice = find_soffice(&app).ok_or(
        "LibreOffice est introuvable. Sous Fedora : sudo dnf install libreoffice-writer libreoffice-calc libreoffice-impress",
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = CONVERT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        convert_with(&soffice, &path, &to, infilter.as_deref(), CONVERT_TIMEOUT_S)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn convert_with(soffice: &Path, path: &str, to: &str, infilter: Option<&str>, timeout_s: u64) -> Result<String, String> {
    let out_dir = app_temp_dir().join("conversions").join(unique_suffix());
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    // Profil LibreOffice séparé : ne touche jamais au profil ni aux réglages de l'utilisateur.
    let profile = app_temp_dir().join("lo-profile");
    let profile_url = format!("file:///{}", profile.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    let out_ext = to.split(':').next().unwrap_or("pdf").to_string();

    let mut cmd = Command::new(soffice);
    cmd.arg(format!("-env:UserInstallation={profile_url}")).args(["--headless", "--norestore"]);
    if let Some(f) = infilter {
        cmd.arg(format!("--infilter={f}"));
    }
    cmd.args(["--convert-to", to, "--outdir"]).arg(&out_dir).arg(path);
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // pas de fenêtre console
    }
    let mut child = cmd.spawn().map_err(|e| format!("Échec du lancement de LibreOffice : {e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed().as_secs() >= timeout_s => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&out_dir);
                return Err(format!(
                    "La conversion a dépassé {timeout_s} secondes et a été arrêtée. Le document est peut-être trop lourd, abîmé ou protégé par mot de passe."
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let _ = e.read_to_string(&mut stderr);
    }
    let stem = Path::new(path).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let result = out_dir.join(format!("{stem}.{out_ext}"));
    if result.exists() {
        Ok(result.to_string_lossy().to_string())
    } else {
        let _ = std::fs::remove_dir_all(&out_dir);
        Err(format!("La conversion a échoué.\n{stderr}"))
    }
}

/// Chemin libre : « nom.pdf » s'il n'existe pas, sinon « nom (2).pdf », « nom (3).pdf »…
#[tauri::command]
fn unique_path(path: String) -> String {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return path;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000)
        .map(|n| p.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or(p)
        .to_string_lossy()
        .to_string()
}

/// Capture d'écran. Sous Linux (Wayland/GNOME) : passe par le portail système,
/// qui affiche son propre sélecteur de zone. macOS : outil de sélection natif (screencapture -i).
/// Windows : capture de l'écran principal, le recadrage se fait ensuite dans l'éditeur.
#[tauri::command]
async fn capture_screen(app: tauri::AppHandle) -> Result<String, String> {
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
async fn tokio_sleep_ms(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

#[cfg(not(target_os = "linux"))]
fn capture_temp_path() -> PathBuf {
    app_temp_dir().join(format!("capture-{}.png", unique_suffix()))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// macOS : outil de sélection natif (comme Cmd+Maj+4). Échap = capture annulée.
#[cfg(target_os = "macos")]
fn grab_screen() -> Result<String, String> {
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
fn grab_screen() -> Result<String, String> {
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

/// Impression native de la fenêtre (macOS : WKWebView ignore window.print()).
#[tauri::command]
fn print_window(app: tauri::AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("Fenêtre introuvable")?;
    w.print().map_err(|e| e.to_string())
}

/// Cherche qpdf : copie embarquée puis système.
fn find_qpdf(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for rel in ["qpdf/bin/qpdf.exe", "qpdf/bin/qpdf", "qpdf/qpdf"] {
            let p = res.join(rel);
            if p.exists() {
                return Some(p);
            }
        }
    }
    if cfg!(windows) {
        // winget / Chocolatey installent dans « C:\Program Files\qpdf 12.x.x\bin »
        for base in [r"C:\Program Files", r"C:\Program Files (x86)"] {
            if let Ok(rd) = std::fs::read_dir(base) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().to_lowercase().starts_with("qpdf") {
                        let p = e.path().join("bin").join("qpdf.exe");
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
        return None;
    }
    ["/usr/bin/qpdf", "/usr/local/bin/qpdf", "/opt/homebrew/bin/qpdf"].iter().map(PathBuf::from).find(|p| p.exists())
}

fn run_qpdf(app: &tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let qpdf = find_qpdf(app).ok_or("qpdf est introuvable. Sous Fedora : sudo dnf install qpdf")?;
    run_qpdf_bin(&qpdf, args)
}

fn run_qpdf_bin(qpdf: &Path, args: Vec<String>) -> Result<(), String> {
    // Les arguments (dont les mots de passe) passent par un fichier privé « @fichier » et non par
    // la ligne de commande, visible des autres programmes de la session (ps, Gestionnaire des tâches).
    let argfile = write_private_argfile(&args)?;
    let mut cmd = Command::new(qpdf);
    cmd.arg(format!("@{}", argfile.to_string_lossy()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // pas de fenêtre console
    }
    let res = cmd.output();
    let _ = std::fs::remove_file(&argfile);
    let out = res.map_err(|e| format!("Échec du lancement de qpdf : {e}"))?;
    // Code 3 = succès avec avertissements
    match out.status.code() {
        Some(0) | Some(3) => Ok(()),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            if err.contains("invalid password") {
                Err("MOT_DE_PASSE_INVALIDE".into())
            } else {
                Err(format!("qpdf : {err}"))
            }
        }
    }
}

/// Fichier d'arguments lisible par le seul utilisateur, un argument par ligne.
fn write_private_argfile(args: &[String]) -> Result<PathBuf, String> {
    use std::io::Write;
    if args.iter().any(|a| a.contains('\n') || a.contains('\r')) {
        return Err("Un mot de passe ne peut pas contenir de retour à la ligne.".into());
    }
    let dir = app_temp_dir();
    let path = dir.join(format!("qpdf-{}-{}.args", std::process::id(), unique_suffix()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path).map_err(|e| format!("Fichier temporaire impossible : {e}"))?;
    f.write_all(args.join("\n").as_bytes()).and_then(|_| f.write_all(b"\n")).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Dossier temporaire propre à SXM PDF (privé sous Linux/macOS).
fn app_temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("sxm-pdf");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    dir
}

/// Nettoyage au démarrage : fichiers temporaires de SXM PDF de plus de `max_age` (pièces jointes
/// envoyées, conversions, captures, copies déchiffrées), et anciens dossiers des versions précédentes.
/// Le profil LibreOffice est conservé (il accélère les conversions).
fn cleanup_temp(max_age: std::time::Duration) -> usize {
    let now = std::time::SystemTime::now();
    let old = |p: &Path| {
        std::fs::symlink_metadata(p)
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or_default() >= max_age)
            .unwrap_or(false)
    };
    let mut removed = 0;
    fn walk(dir: &Path, old: &dyn Fn(&Path) -> bool, removed: &mut usize, keep: &Path) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p == keep { continue; }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, old, removed, keep);
                let _ = std::fs::remove_dir(&p); // seulement s'il est vide
            } else if old(&p) && std::fs::remove_file(&p).is_ok() {
                *removed += 1;
            }
        }
    }
    let base = app_temp_dir();
    walk(&base, &old, &mut removed, &base.join("lo-profile"));
    // Anciennes versions : dossiers et captures directement dans le dossier temporaire du système
    let tmp = std::env::temp_dir();
    for name in ["sxm-pdf-envoi", "sxm-pdf-conversions", "sxm-pdf-decrypted", "sxm-pdf-lo-profile"] {
        let d = tmp.join(name);
        if d.is_dir() && old(&d) && std::fs::remove_dir_all(&d).is_ok() {
            removed += 1;
        }
    }
    if let Ok(rd) = std::fs::read_dir(&tmp) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("sxm-capture-") && n.ends_with(".png") && old(&e.path()) && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

fn unique_suffix() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{t}-{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Protège un PDF par mot de passe (AES-256). input peut être égal à output.
#[tauri::command]
async fn pdf_encrypt(
    app: tauri::AppHandle,
    input: String,
    output: String,
    user_pw: String,
    owner_pw: String,
    allow_print: bool,
    allow_copy: bool,
    allow_modify: bool,
) -> Result<(), String> {
    let args = vec![
        "--encrypt".to_string(),
        user_pw,
        owner_pw,
        "256".into(),
        format!("--print={}", if allow_print { "full" } else { "none" }),
        format!("--extract={}", if allow_copy { "y" } else { "n" }),
        format!("--modify={}", if allow_modify { "all" } else { "none" }),
        "--".into(),
        input.clone(),
    ];
    let qpdf = find_qpdf(&app).ok_or("qpdf est introuvable. Sous Fedora : sudo dnf install qpdf")?;
    tauri::async_runtime::spawn_blocking(move || encrypt_with(&qpdf, args, &input, &output))
        .await
        .map_err(|e| e.to_string())?
}

/// Chiffre `input` vers `output`. Le fichier final n'est remplacé qu'une fois le chiffrement réussi :
/// en cas d'échec, l'ancien fichier reste intact et aucune version en clair n'est laissée à sa place.
fn encrypt_with(qpdf: &Path, mut args: Vec<String>, input: &str, output: &str) -> Result<(), String> {
    if input == output {
        // qpdf écrit lui-même dans un temporaire puis remplace le fichier
        args.push("--replace-input".into());
        return run_qpdf_bin(qpdf, args);
    }
    let dest = PathBuf::from(output);
    let tmp = sibling_tmp(&dest);
    args.push(tmp.to_string_lossy().to_string());
    let res = run_qpdf_bin(qpdf, args).and_then(|_| replace_file(&tmp, &dest).map_err(|e| format!("Remplacement impossible : {e}")));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Retire la protection d'un PDF (mot de passe requis). Renvoie le chemin du PDF déchiffré.
#[tauri::command]
async fn pdf_decrypt(app: tauri::AppHandle, input: String, password: String) -> Result<String, String> {
    let out = app_temp_dir().join(format!("dechiffre-{}.pdf", unique_suffix()));
    let out_s = out.to_string_lossy().to_string();
    let args = vec![format!("--password={password}"), "--decrypt".into(), input, out_s.clone()];
    tauri::async_runtime::spawn_blocking(move || run_qpdf(&app, args))
        .await
        .map_err(|e| e.to_string())??;
    Ok(out_s)
}

/// Droits d'un PDF protégé (lus par qpdf avec le mot de passe fourni), pour les conserver
/// quand le document est réenregistré.
#[tauri::command]
async fn pdf_encryption_info(app: tauri::AppHandle, input: String, password: String) -> Result<serde_json::Value, String> {
    let qpdf = find_qpdf(&app).ok_or("qpdf est introuvable.")?;
    tauri::async_runtime::spawn_blocking(move || encryption_info_with(&qpdf, &input, &password))
        .await
        .map_err(|e| e.to_string())?
}

fn encryption_info_with(qpdf: &Path, input: &str, password: &str) -> Result<serde_json::Value, String> {
    let argfile = write_private_argfile(&[format!("--password={password}"), "--show-encryption".into(), input.into()])?;
    let out = Command::new(qpdf).arg(format!("@{}", argfile.to_string_lossy())).output();
    let _ = std::fs::remove_file(&argfile);
    let out = out.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    // qpdf affiche les droits même avec un mauvais mot de passe : on le refuse explicitement
    if text.contains("Incorrect password supplied") {
        return Err("MOT_DE_PASSE_INVALIDE".into());
    }
    if !matches!(out.status.code(), Some(0) | Some(3)) {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if err.contains("invalid password") { "MOT_DE_PASSE_INVALIDE".into() } else { format!("qpdf : {err}") });
    }
    Ok(parse_encryption_info(&text))
}

fn parse_encryption_info(text: &str) -> serde_json::Value {
    let allowed = |label: &str| {
        text.lines().find(|l| l.trim_start().starts_with(label)).map(|l| l.trim_end().ends_with(": allowed")).unwrap_or(true)
    };
    serde_json::json!({
        "encrypted": !text.contains("File is not encrypted"),
        "ownerSupplied": text.contains("Supplied password is owner password"),
        "print": allowed("print high resolution"),
        "copy": allowed("extract for any purpose"),
        "modify": allowed("modify other"),
    })
}

/// Supprime un fichier temporaire créé par SXM PDF (uniquement dans le dossier temporaire).
#[tauri::command]
fn remove_temp(path: String) {
    if is_in_temp(Path::new(&path)) {
        let _ = std::fs::remove_file(path);
    }
}

/// Vrai si le chemin, une fois résolu (liens et « .. » compris), est dans le dossier temporaire.
fn is_in_temp(p: &Path) -> bool {
    let (Ok(file), Ok(tmp)) = (p.canonicalize(), std::env::temp_dir().canonicalize()) else { return false };
    file.starts_with(tmp) && file.is_file()
}

/// Ouvre un nouveau message dans la messagerie par défaut avec le PDF en pièce jointe.
#[tauri::command]
async fn send_mail(path: String, subject: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || send_mail_impl(&path, &subject))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
fn send_mail_impl(path: &str, subject: &str) -> Result<String, String> {
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
fn send_mail_impl(path: &str, _subject: &str) -> Result<String, String> {
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
fn mac_mail_handler() -> Option<String> {
    let out = Command::new("defaults")
        .args(["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"])
        .output()
        .ok()?;
    parse_mailto_handler(&String::from_utf8_lossy(&out.stdout))
}

/// Cherche, dans la sortie de `defaults read … LSHandlers`, l'application associée à « mailto ».
#[cfg(any(target_os = "macos", test))]
fn parse_mailto_handler(text: &str) -> Option<String> {
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
fn send_mail_impl(path: &str, subject: &str) -> Result<String, String> {
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

/// Affiche le fichier dans le gestionnaire de fichiers.
fn reveal(path: &str) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(format!("/select,{path}")).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").args(["-R", path]).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open")
        .arg(Path::new(path).parent().unwrap_or(Path::new("/")))
        .spawn();
}

/// Fichier de données de l'utilisateur (signatures, tampons, profils, modèles).
/// Linux : ~/.config/com.sxm.pdf/ · Windows : %APPDATA%\\com.sxm.pdf\\ · macOS : ~/Library/Application Support/com.sxm.pdf/
fn data_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dossier de configuration inaccessible : {e}"))?;
    Ok(dir.join("sxm-pdf-donnees.json"))
}

// ======================================================================= Données utilisateur (fichier JSON)
//
// Règles :
//  - un seul verrou (DATA_LOCK) protège toutes les opérations sur le fichier de données
//    (lecture, écriture, restauration, mise de côté) : jamais deux opérations simultanées côté Rust ;
//    les fonctions internes ne reprennent jamais le verrou → pas d'interblocage ;
//  - écriture dans un fichier temporaire forcé sur le disque, puis remplacement atomique (replace_file) ;
//  - le .bak est lui aussi écrit de façon atomique, et uniquement à partir d'une version valide ;
//  - le contenu est validé (structure, version du format) avant toute écriture ou restauration.

static DATA_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Exécute f en tenant le verrou des données (un verrou empoisonné par un panic est récupéré).
fn with_data_lock<T>(f: impl FnOnce() -> T) -> T {
    let _g = DATA_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    f()
}

/// Version du format du fichier de données. Un fichier d'une version plus récente est refusé.
const DATA_FORMAT: u64 = 1;

#[tauri::command]
async fn data_load(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| load_json_file(&f))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn data_save(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| save_json_file(&f, &content))).await.map_err(|e| e.to_string())?
}

/// Contrôle de structure du fichier de données (types de chaque rubrique, version du format).
/// Les contrôles détaillés champ par champ sont faits en plus côté interface avant un import
/// ou une restauration ; ici on garantit qu'aucun fichier de forme incorrecte n'est écrit ni restauré.
fn validate_data(v: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    let obj = v.as_object().ok_or("objet JSON attendu")?;
    if let Some(fmt) = obj.get("_format") {
        let n = fmt.as_u64().ok_or("numéro de format invalide")?;
        if n == 0 || n > DATA_FORMAT {
            return Err(format!("format {n} non pris en charge par cette version de SXM PDF"));
        }
    }
    let is_str = |o: &serde_json::Map<String, Value>, k: &str| o.get(k).map(|x| x.is_string()).unwrap_or(false);
    let is_obj = |o: &serde_json::Map<String, Value>, k: &str| o.get(k).map(|x| x.is_object()).unwrap_or(false);
    for key in ["sxm.initials", "sxm.initialsStyle", "sxm.theme", "sxm.welcomed"] {
        if let Some(x) = obj.get(key) {
            if !x.is_string() {
                return Err(format!("« {key} » doit être un texte"));
            }
        }
    }
    let lists: [(&str, fn(&serde_json::Map<String, Value>) -> bool); 4] = [
        ("sxm.signatures", |o| {
            o.get("src").and_then(|x| x.as_str()).map(|s| s.starts_with("data:image/")).unwrap_or(false)
                && o.get("ratio").and_then(|x| x.as_f64()).map(|r| r > 0.0).unwrap_or(false)
        }),
        ("sxm.stamps", |o| o.get("label").map(|x| x.is_string()).unwrap_or(false) && o.get("color").map(|x| x.is_string()).unwrap_or(false)),
        ("sxm.watermarkTemplates", |o| {
            o.get("name").map(|x| x.is_string()).unwrap_or(false)
                && o.get("opt").and_then(|x| x.as_object()).map(|p| p.get("text").map(|t| t.is_string()).unwrap_or(false)).unwrap_or(false)
        }),
        ("sxm.batchProfiles", |_| true), // contrôlé juste après (besoin des fermetures)
    ];
    for (key, check) in lists {
        let Some(x) = obj.get(key) else { continue };
        let arr = x.as_array().ok_or(format!("« {key} » doit être une liste"))?;
        for (i, item) in arr.iter().enumerate() {
            let o = item.as_object().ok_or(format!("« {key} » n° {} : objet attendu", i + 1))?;
            let ok = if key == "sxm.batchProfiles" {
                is_str(o, "name") && is_obj(o, "par") && is_obj(o, "sig") && is_obj(o, "stamp") && is_obj(o, "out")
                    && o.get("pw").map(|p| p.is_boolean()).unwrap_or(false)
            } else {
                check(o)
            };
            if !ok {
                return Err(format!("« {key} » n° {} invalide", i + 1));
            }
        }
    }
    Ok(())
}

fn parse_valid(s: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("JSON invalide : {e}"))?;
    validate_data(&v)?;
    Ok(v)
}

/// Lit le fichier de données. S'il est absent : « {} ». S'il est illisible, corrompu ou de structure
/// incorrecte, on se rabat sur la copie de secours .bak si elle est valide.
fn load_json_file(f: &Path) -> Result<String, String> {
    let valid = |s: &str| parse_valid(s).is_ok();
    match std::fs::read_to_string(f) {
        Ok(s) if valid(&s) => return Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !f.with_extension("json.bak").exists() => {
            return Ok("{}".into())
        }
        _ => {}
    }
    match std::fs::read_to_string(f.with_extension("json.bak")) {
        Ok(s) if valid(&s) => Ok(s),
        _ if !f.exists() => Ok("{}".into()),
        _ => Err("Le fichier de données est endommagé et aucune copie de secours valide n'a été trouvée.".into()),
    }
}

/// Remplacement atomique de `dst` par `src`, y compris lorsque `dst` existe déjà.
/// - Windows : MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) — appel explicite
///   (std::fs::rename fait déjà MOVEFILE_REPLACE_EXISTING ; WRITE_THROUGH garantit en plus que le
///   renommage est écrit sur le disque avant le retour). Si la destination est ouverte par un autre
///   programme, repli sur std::fs::rename (sémantique POSIX de Windows 10+). Aucune dépendance ajoutée.
/// - Linux / macOS : rename(2), atomique, puis synchronisation du dossier pour rendre le renommage durable.
fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        let w = |p: &Path| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (a, b) = (w(src), w(dst));
        let ok = unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
        if ok != 0 {
            return Ok(());
        }
        // Destination ouverte par un autre programme (ERROR_ACCESS_DENIED…) : std::fs::rename
        // réessaie avec la sémantique POSIX de Windows 10+ (FileRenameInfoEx), qui le permet.
        let first = std::io::Error::last_os_error();
        std::fs::rename(src, dst).map_err(|_| first)
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(src, dst)?;
        if let Some(dir) = dst.parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    }
}

/// Écrit `content` dans `path` de façon atomique (fichier .tmp + remplacement), avec réessais
/// si le fichier est momentanément verrouillé (antivirus, indexation, OneDrive…).
fn atomic_write<R>(path: &Path, tmp: &Path, content: &[u8], rename: &R) -> Result<(), String>
where
    R: Fn(&Path, &Path) -> std::io::Result<()>,
{
    use std::io::Write;
    let write_tmp = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(tmp)?;
        file.write_all(content)?;
        file.sync_all()
    };
    if let Err(e) = write_tmp() {
        let _ = std::fs::remove_file(tmp);
        return Err(format!("Écriture impossible : {e}"));
    }
    let mut last_err = None;
    for attempt in 0..6u64 {
        match rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(60 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(tmp);
    Err(format!(
        "Sauvegarde impossible (fichier verrouillé ?) : {}. Vos données précédentes sont conservées.",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Sauvegarde sûre, identique sous Linux, macOS et Windows.
fn save_json_file(f: &Path, content: &str) -> Result<(), String> {
    save_json_file_with(f, content, true, replace_file)
}

/// Même chose, avec la fonction de remplacement injectable (tests d'échec) et le choix de mettre à jour
/// ou non la copie .bak. Étapes : validation → .bak atomique de la version actuelle si elle est valide →
/// écriture atomique du nouveau contenu. Un échec à n'importe quelle étape laisse le fichier principal intact.
fn save_json_file_with<R>(f: &Path, content: &str, update_bak: bool, rename: R) -> Result<(), String>
where
    R: Fn(&Path, &Path) -> std::io::Result<()>,
{
    parse_valid(content).map_err(|e| format!("Données invalides : {e}"))?;
    if update_bak {
        if let Ok(cur) = std::fs::read_to_string(f) {
            if parse_valid(&cur).is_ok() {
                // Échec du .bak non bloquant : la sauvegarde principale reste prioritaire.
                let _ = atomic_write(&f.with_extension("json.bak"), &f.with_extension("json.bak.tmp"), cur.as_bytes(), &rename);
            }
        }
    }
    atomic_write(f, &f.with_extension("json.tmp"), content.as_bytes(), &rename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sxm-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn read(p: &Path) -> String { std::fs::read_to_string(p).unwrap() }

    #[test]
    fn cinquante_sauvegardes_sur_fichier_existant() {
        let f = dir("rep").join("sxm-pdf-donnees.json");
        std::fs::write(&f, "{\"n\":-1}").unwrap(); // fichier déjà présent
        for i in 0..60 {
            save_json_file(&f, &format!("{{\"n\":{i}}}")).unwrap();
            assert_eq!(load_json_file(&f).unwrap(), format!("{{\"n\":{i}}}"));
        }
        assert_eq!(read(&f.with_extension("json.bak")), "{\"n\":58}");
        assert!(!f.with_extension("json.tmp").exists());
    }

    #[test]
    fn echec_de_renommage_garde_les_donnees_precedentes() {
        let f = dir("ren").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        let calls = Cell::new(0);
        let r = save_json_file_with(&f, "{\"v\":3}", true, |_, _| {
            calls.set(calls.get() + 1);
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "verrouillé"))
        });
        assert!(r.is_err());
        // 6 tentatives pour le .bak (non bloquant) + 6 tentatives pour le fichier principal
        assert_eq!(calls.get(), 12, "6 + 6 tentatives attendues");
        assert_eq!(read(&f), "{\"v\":2}", "le fichier précédent doit rester intact");
        assert!(!f.with_extension("json.tmp").exists(), "le temporaire doit être supprimé");
        assert_eq!(load_json_file(&f).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn renommage_reussi_apres_verrou_temporaire() {
        let f = dir("lock").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        let calls = Cell::new(0);
        save_json_file_with(&f, "{\"v\":2}", true, |a, b| {
            calls.set(calls.get() + 1);
            if calls.get() < 3 { Err(std::io::Error::new(std::io::ErrorKind::Other, "antivirus")) } else { replace_file(a, b) }
        })
        .unwrap();
        assert_eq!(read(&f), "{\"v\":2}");
    }

    #[test]
    fn fichier_temporaire_impossible_a_creer() {
        let f = dir("tmp").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        std::fs::create_dir_all(f.with_extension("json.tmp").join("bloque")).unwrap(); // le .tmp est un dossier
        assert!(save_json_file(&f, "{\"v\":2}").is_err());
        assert_eq!(read(&f), "{\"v\":1}");
    }

    #[test]
    fn json_invalide_refuse_sans_toucher_au_fichier() {
        let f = dir("inv").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"ok\":1}").unwrap();
        for bad in ["{pas du json", "[1,2]", "null", "\"texte\"", ""] {
            assert!(save_json_file(&f, bad).is_err(), "devait refuser {bad:?}");
        }
        assert_eq!(read(&f), "{\"ok\":1}");
        assert!(!f.with_extension("json.bak").exists(), "un refus ne doit pas créer de .bak");
    }

    #[test]
    fn lecture_corrompue_restauree_depuis_bak() {
        let f = dir("cor").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        std::fs::write(&f, "{\"v\":2, tronqu").unwrap();
        assert_eq!(load_json_file(&f).unwrap(), "{\"v\":1}");
        save_json_file(&f, "{\"v\":3}").unwrap();
        assert_eq!(read(&f.with_extension("json.bak")), "{\"v\":1}", "le .bak valide ne doit pas être écrasé par un fichier corrompu");
    }

    #[test]
    fn sans_copie_de_secours() {
        let d = dir("nobak");
        let f = d.join("sxm-pdf-donnees.json");
        assert_eq!(load_json_file(&f).unwrap(), "{}", "premier lancement");
        std::fs::write(&f, "corrompu").unwrap();
        assert!(load_json_file(&f).is_err(), "corrompu sans .bak : erreur explicite, pas de données vides silencieuses");
        assert!(restore_backup_file(&f).is_err());
        assert_eq!(read(&f), "corrompu", "le fichier n'est pas effacé");
    }

    #[test]
    fn fichier_illisible_mis_de_cote_sans_perte() {
        let f = dir("quar").join("sxm-pdf-donnees.json");
        std::fs::write(&f, "corrompu").unwrap();
        let q = quarantine_file(&f).unwrap();
        assert_eq!(read(Path::new(&q)), "corrompu");
        assert_eq!(load_json_file(&f).unwrap(), "{}");
        save_json_file(&f, "{\"v\":1}").unwrap();
        assert_eq!(read(Path::new(&q)), "corrompu", "la copie mise de côté n'est jamais écrasée");
    }

    #[test]
    fn restauration_manuelle_depuis_bak() {
        let f = dir("rest").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        assert_eq!(restore_backup_file(&f).unwrap(), "{\"v\":1}");
        assert_eq!(read(&f), "{\"v\":1}");
        assert_eq!(read(&f.with_extension("json.bak")), "{\"v\":1}");
        std::fs::write(f.with_extension("json.bak"), "abîmé").unwrap();
        assert!(restore_backup_file(&f).is_err());
        assert_eq!(read(&f), "{\"v\":1}");
    }

    // ---------------------------------------------------------------- tests ajoutés (corrections finales)

    const SIG: &str = "data:image/png;base64,AAAA";

    #[test]
    fn remplacement_d_un_fichier_existant() {
        // Vérifié sur chaque système par la CI (Windows : MoveFileExW REPLACE_EXISTING | WRITE_THROUGH)
        let d = dir("repl");
        let (a, b) = (d.join("a.json"), d.join("b.json"));
        std::fs::write(&b, "ancien").unwrap();
        std::fs::write(&a, "nouveau").unwrap();
        replace_file(&a, &b).unwrap();
        assert_eq!(read(&b), "nouveau");
        assert!(!a.exists());
        for i in 0..20 { // remplacements répétés d'un fichier présent
            std::fs::write(&a, format!("v{i}")).unwrap();
            replace_file(&a, &b).unwrap();
            assert_eq!(read(&b), format!("v{i}"));
        }
    }

    #[test]
    fn sauvegarde_pendant_qu_un_lecteur_garde_le_fichier_ouvert() {
        // Cas réel sous Windows : antivirus / indexeur qui lit le fichier pendant la sauvegarde
        let f = dir("open").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        let handle = std::fs::File::open(&f).unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        drop(handle);
        assert_eq!(read(&f), "{\"v\":2}");
    }

    #[test]
    fn bak_de_structure_invalide_refuse() {
        let f = dir("bakinv").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"sxm.initials\":\"OK\"}").unwrap();
        let bad_baks = [
            "{\"sxm.signatures\":\"pas une liste\"}",
            "{\"sxm.signatures\":[{\"src\":\"javascript:x\",\"ratio\":2}]}",
            "{\"sxm.signatures\":[null]}",
            "{\"sxm.stamps\":[{\"label\":\"X\"}]}",
            "{\"sxm.initials\":12}",
            "{\"sxm.batchProfiles\":[{\"name\":\"P\",\"par\":null,\"sig\":{},\"stamp\":{},\"out\":{},\"pw\":false}]}",
            "{\"sxm.watermarkTemplates\":[{\"name\":\"M\",\"opt\":{}}]}",
            "[1,2]",
        ];
        for bak in bad_baks {
            std::fs::write(f.with_extension("json.bak"), bak).unwrap();
            let r = restore_backup_file(&f);
            assert!(r.is_err(), "devait refuser {bak}");
            assert_eq!(read(&f), "{\"sxm.initials\":\"OK\"}", "le fichier principal ne doit pas changer");
        }
    }

    #[test]
    fn bak_de_format_plus_recent_refuse() {
        let f = dir("bakfmt").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"_format\":1}").unwrap();
        std::fs::write(f.with_extension("json.bak"), "{\"_format\":2,\"sxm.initials\":\"X\"}").unwrap();
        assert!(restore_backup_file(&f).unwrap_err().contains("incompatible"));
        assert_eq!(read(&f), "{\"_format\":1}");
        assert!(save_json_file(&f, "{\"_format\":0}").is_err());
        assert!(save_json_file(&f, "{\"_format\":\"1\"}").is_err());
    }

    #[test]
    fn bak_valide_complet_restaure() {
        let f = dir("bakok").join("sxm-pdf-donnees.json");
        let good = format!(
            "{{\"_format\":1,\"sxm.signatures\":[{{\"src\":\"{SIG}\",\"ratio\":3}}],\"sxm.stamps\":[{{\"label\":\"REÇU\",\"color\":\"#1d4ed8\"}}],\"sxm.initials\":\"L.H.\",\"sxm.watermarkTemplates\":[{{\"name\":\"RH\",\"opt\":{{\"text\":\"CONFIDENTIEL\"}}}}],\"sxm.batchProfiles\":[{{\"name\":\"Contrats\",\"par\":{{}},\"sig\":{{}},\"stamp\":{{}},\"out\":{{}},\"pw\":true}}]}}"
        );
        save_json_file(&f, &good).unwrap();
        save_json_file(&f, "{\"_format\":1}").unwrap();
        assert_eq!(restore_backup_file(&f).unwrap(), good);
        assert_eq!(read(&f), good);
    }

    #[test]
    fn echec_de_restauration_conserve_le_fichier_principal() {
        let f = dir("restfail").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        let r = restore_backup_file_with(&f, |_, _| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "verrouillé")));
        assert!(r.is_err());
        assert_eq!(read(&f), "{\"v\":2}");
        assert_eq!(read(&f.with_extension("json.bak")), "{\"v\":1}");
    }

    #[test]
    fn contenu_de_structure_invalide_jamais_ecrit() {
        let f = dir("structinv").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        assert!(save_json_file(&f, "{\"sxm.signatures\":{}}").is_err());
        assert!(save_json_file(&f, "{\"sxm.stamps\":[\"texte\"]}").is_err());
        assert_eq!(read(&f), "{\"v\":1}");
    }

    #[test]
    fn operations_simultanees_sans_corruption() {
        // 8 rédacteurs × 25 sauvegardes + 4 lecteurs + restaurations + mise de côté, en parallèle,
        // tous via le verrou unique : chaque lecture doit toujours obtenir un JSON valide.
        let f = std::sync::Arc::new(dir("conc").join("sxm-pdf-donnees.json"));
        save_json_file(&f, "{\"w\":0,\"i\":0}").unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let bad = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut hs = vec![];
        for w in 0..8 {
            let f = f.clone();
            hs.push(std::thread::spawn(move || {
                for i in 0..25 {
                    with_data_lock(|| save_json_file(&f, &format!("{{\"w\":{w},\"i\":{i}}}"))).unwrap();
                }
            }));
        }
        let mut readers = vec![];
        for _ in 0..4 {
            let (f, stop, bad) = (f.clone(), stop.clone(), bad.clone());
            readers.push(std::thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let s = with_data_lock(|| load_json_file(&f));
                    if s.map(|s| parse_valid(&s).is_err()).unwrap_or(true) { bad.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                }
            }));
        }
        {
            let f = f.clone();
            hs.push(std::thread::spawn(move || {
                for _ in 0..10 { let _ = with_data_lock(|| restore_backup_file(&f)); }
            }));
        }
        for h in hs { h.join().unwrap(); }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for r in readers { r.join().unwrap(); }
        assert_eq!(bad.load(std::sync::atomic::Ordering::Relaxed), 0, "aucune lecture corrompue");
        assert!(parse_valid(&read(&f)).is_ok());
        assert!(parse_valid(&read(&f.with_extension("json.bak"))).is_ok());
        assert!(!f.with_extension("json.tmp").exists());
        assert!(!f.with_extension("json.bak.tmp").exists());
        // mise de côté pendant que tout est au repos, deux fois de suite : jamais d'écrasement
        let q1 = with_data_lock(|| quarantine_file(&f)).unwrap();
        save_json_file(&f, "{\"apres\":1}").unwrap();
        let q2 = with_data_lock(|| quarantine_file(&f)).unwrap();
        assert_ne!(q1, q2);
        assert!(Path::new(&q1).exists() && Path::new(&q2).exists());
    }

    #[test]
    fn interruption_pendant_une_sauvegarde() {
        let f = dir("crash").join("sxm-pdf-donnees.json");
        save_json_file(&f, "{\"v\":1}").unwrap();
        save_json_file(&f, "{\"v\":2}").unwrap();
        // Coupure après l'écriture partielle du temporaire (avant le remplacement)
        std::fs::write(f.with_extension("json.tmp"), "{\"v\":3, coupu").unwrap();
        std::fs::write(f.with_extension("json.bak.tmp"), "{\"v\":").unwrap();
        assert_eq!(load_json_file(&f).unwrap(), "{\"v\":2}", "le temporaire abandonné est ignoré");
        save_json_file(&f, "{\"v\":3}").unwrap();
        assert_eq!(read(&f), "{\"v\":3}");
        assert_eq!(read(&f.with_extension("json.bak")), "{\"v\":2}");
        // Coupure qui aurait laissé un fichier principal tronqué : récupération par le .bak
        std::fs::write(&f, "{\"v\":4, tron").unwrap();
        assert_eq!(load_json_file(&f).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn soixante_sauvegardes_avec_bak_toujours_valide() {
        let f = dir("sixty").join("sxm-pdf-donnees.json");
        std::fs::write(&f, "{\"n\":-1}").unwrap();
        for i in 0..60 {
            save_json_file(&f, &format!("{{\"_format\":1,\"n\":{i}}}")).unwrap();
            assert!(parse_valid(&read(&f.with_extension("json.bak"))).is_ok());
        }
        assert_eq!(read(&f), "{\"_format\":1,\"n\":59}");
    }


    // ---------------------------------------------------------------- tests consolidation v1 (lot 1)

    /// PDF minimal valide d'une page contenant le texte SECRET-RH (flux non compressé).
    fn mini_pdf() -> Vec<u8> {
        let content = "BT /F1 12 Tf 72 720 Td (SECRET-RH) Tj ET";
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), content),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offs = vec![];
        for (i, o) in objs.iter().enumerate() {
            offs.push(out.len());
            out.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, o).as_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
        for o in offs { out.extend(format!("{o:010} 00000 n \n").as_bytes()); }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).as_bytes());
        out
    }

    fn system_qpdf() -> Option<PathBuf> {
        ["/usr/bin/qpdf", "/usr/local/bin/qpdf", "/opt/homebrew/bin/qpdf"].iter().map(PathBuf::from).find(|p| p.exists())
            .or_else(|| Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success()).map(|_| PathBuf::from("qpdf")))
    }

    #[test]
    fn ecriture_pdf_sure_remplace_sans_laisser_de_temporaire() {
        let d = dir("pdfw");
        let f = d.join("contrat signé.pdf");
        std::fs::write(&f, b"ancienne version").unwrap();
        write_file_safely(&f, b"nouvelle version").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"nouvelle version");
        assert!(!sibling_tmp(&f).exists(), "aucun fichier temporaire ne doit rester");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
    }

    #[test]
    fn ecriture_pdf_echec_garde_l_original() {
        let d = dir("pdfwko");
        let f = d.join("original.pdf");
        std::fs::write(&f, b"ORIGINAL").unwrap();
        std::fs::create_dir_all(sibling_tmp(&f).join("bloque")).unwrap(); // le temporaire est un dossier : écriture impossible
        assert!(write_file_safely(&f, b"NOUVEAU").is_err());
        assert_eq!(std::fs::read(&f).unwrap(), b"ORIGINAL", "l'original doit rester intact");
    }

    #[test]
    fn suppression_temporaire_refuse_hors_du_dossier_temporaire() {
        let outside = dir("hors").join("garder.txt");
        std::fs::write(&outside, b"x").unwrap();
        // chemin qui « commence » par le dossier temporaire mais remonte ailleurs avec ..
        let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"));
        let sneaky = std::env::temp_dir().join("..").join(home.strip_prefix("/").unwrap_or(&home)).join("fichier-inexistant");
        assert!(!is_in_temp(&sneaky));
        let inside = app_temp_dir().join(format!("t-{}", unique_suffix()));
        std::fs::write(&inside, b"x").unwrap();
        assert!(is_in_temp(&inside));
        remove_temp(inside.to_string_lossy().to_string());
        assert!(!inside.exists());
        assert!(is_in_temp(&outside), "dir() de test est lui-même dans le dossier temporaire");
    }

    #[test]
    fn fichier_d_arguments_prive_et_sans_retour_ligne() {
        let f = write_private_argfile(&["--password=Mot de passe é".into(), "--decrypt".into()]).unwrap();
        assert_eq!(read(&f), "--password=Mot de passe é\n--decrypt\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_file(&f);
        assert!(write_private_argfile(&["a\nb".into()]).is_err());
    }

    #[test]
    fn chiffrement_vers_destination_puis_echec_sans_toucher_l_original() {
        let Some(qpdf) = system_qpdf() else { eprintln!("qpdf absent : test ignoré"); return };
        let d = dir("enc");
        let clair = d.join("clair.pdf");
        std::fs::write(&clair, mini_pdf()).unwrap();
        let dest = d.join("protégé.pdf");
        std::fs::write(&dest, b"ANCIEN PDF PROTEGE").unwrap();
        let args = |input: &Path| vec!["--encrypt".into(), "Utilisateur 1".into(), "Proprio 2".into(), "256".into(), "--".into(), input.to_string_lossy().to_string()];
        // 1. succès : la destination est chiffrée, sans texte en clair, et demande le mot de passe
        encrypt_with(&qpdf, args(&clair), &clair.to_string_lossy(), &dest.to_string_lossy()).unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        assert!(!bytes.windows(9).any(|w| w == b"SECRET-RH"), "aucun texte en clair");
        let st = Command::new(&qpdf).arg("--requires-password").arg(&dest).status().unwrap();
        assert_eq!(st.code(), Some(0), "le fichier doit demander un mot de passe");
        assert!(run_qpdf_bin(&qpdf, vec!["--password=Utilisateur 1".into(), "--check".into(), dest.to_string_lossy().to_string()]).is_ok(), "mot de passe avec espace accepté");
        assert_eq!(run_qpdf_bin(&qpdf, vec!["--password=faux".into(), "--check".into(), dest.to_string_lossy().to_string()]), Err("MOT_DE_PASSE_INVALIDE".into()));
        // 2. échec (source illisible) : la destination n'est pas modifiée, pas de temporaire
        let avant = std::fs::read(&dest).unwrap();
        let abime = d.join("abime.pdf");
        std::fs::write(&abime, b"pas un pdf").unwrap();
        assert!(encrypt_with(&qpdf, args(&abime), &abime.to_string_lossy(), &dest.to_string_lossy()).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), avant, "destination intacte après un échec");
        assert!(!sibling_tmp(&dest).exists());
    }

    // ---------------------------------------------------------------- tests consolidation v1 (lot 2)

    #[test]
    fn nom_unique_sans_ecrasement() {
        let d = dir("uniq");
        let f = d.join("rapport.pdf");
        assert_eq!(unique_path(f.to_string_lossy().to_string()), f.to_string_lossy());
        std::fs::write(&f, b"1").unwrap();
        assert_eq!(unique_path(f.to_string_lossy().to_string()), d.join("rapport (2).pdf").to_string_lossy());
        std::fs::write(d.join("rapport (2).pdf"), b"2").unwrap();
        assert_eq!(unique_path(f.to_string_lossy().to_string()), d.join("rapport (3).pdf").to_string_lossy());
    }

    /// Faux « soffice » (script) pour tester la conversion sans LibreOffice.
    #[cfg(unix)]
    fn fake_soffice(name: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir(name).join("soffice");
        std::fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn conversion_ratee_n_ouvre_jamais_un_ancien_resultat() {
        // 1re conversion réussie de « lettre.docx » → lettre.pdf
        let ok = fake_soffice("lo-ok", r#"for a; do last="$a"; prev2="$prev"; prev="$a"; done
outdir=""; n=0; for a; do if [ "$p" = "--outdir" ]; then outdir="$a"; fi; p="$a"; done
b=$(basename "$last"); echo "PDF-OK" > "$outdir/${b%.*}.pdf""#);
        let doc = dir("lo-doc").join("lettre.docx");
        std::fs::write(&doc, b"x").unwrap();
        let r1 = convert_with(&ok, &doc.to_string_lossy(), "pdf", None, 10).unwrap();
        assert_eq!(read(Path::new(&r1)), "PDF-OK\n");
        // 2e conversion du même nom qui échoue sans rien produire : erreur, pas l'ancien fichier
        let ko = fake_soffice("lo-ko", "echo 'erreur LibreOffice' >&2; exit 0");
        let r2 = convert_with(&ko, &doc.to_string_lossy(), "pdf", None, 10);
        assert!(r2.is_err(), "doit échouer au lieu de renvoyer {r2:?}");
        assert!(r2.unwrap_err().contains("erreur LibreOffice"));
    }

    #[cfg(unix)]
    #[test]
    fn conversion_bloquee_arretee_apres_le_delai() {
        let slow = fake_soffice("lo-slow", "sleep 30");
        let doc = dir("lo-doc2").join("lourd.docx");
        std::fs::write(&doc, b"x").unwrap();
        let t = std::time::Instant::now();
        let r = convert_with(&slow, &doc.to_string_lossy(), "pdf", None, 2);
        assert!(r.unwrap_err().contains("dépassé 2 secondes"));
        assert!(t.elapsed().as_secs() < 10, "LibreOffice doit être arrêté rapidement");
    }

    #[test]
    fn vraie_conversion_libreoffice_si_installe() {
        let Some(lo) = ["/usr/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", r"C:\Program Files\LibreOffice\program\soffice.exe"]
            .iter().map(PathBuf::from).find(|p| p.exists()) else { eprintln!("LibreOffice absent : test ignoré"); return };
        let doc = dir("lo-vrai").join("lettre é.txt");
        std::fs::write(&doc, "Lettre de test SXM\nDeuxième ligne").unwrap();
        let pdf = convert_with(&lo, &doc.to_string_lossy(), "pdf", None, 120).unwrap();
        let bytes = std::fs::read(&pdf).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "un vrai PDF doit être produit");
        assert!(Path::new(&pdf).starts_with(app_temp_dir().join("conversions")));
    }

    // ---------------------------------------------------------------- tests consolidation v1 (lot 3)

    #[test]
    fn droits_d_un_pdf_protege_lus_et_conserves() {
        let Some(qpdf) = system_qpdf() else { eprintln!("qpdf absent : test ignoré"); return };
        let d = dir("droits");
        let clair = d.join("clair.pdf");
        std::fs::write(&clair, mini_pdf()).unwrap();
        let restreint = d.join("restreint.pdf");
        let s = |p: &Path| p.to_string_lossy().to_string();
        let enc = |user: &str, owner: &str, print: &str, extract: &str, modify: &str, out: &Path| {
            encrypt_with(&qpdf, vec!["--encrypt".into(), user.into(), owner.into(), "256".into(),
                format!("--print={print}"), format!("--extract={extract}"), format!("--modify={modify}"), "--".into(), s(&clair)], &s(&clair), &s(out)).unwrap()
        };
        enc("lecteur", "chef", "none", "n", "none", &restreint);
        let i = encryption_info_with(&qpdf, &s(&restreint), "lecteur").unwrap();
        assert_eq!(i["ownerSupplied"], false);
        assert_eq!((i["print"].as_bool(), i["copy"].as_bool(), i["modify"].as_bool()), (Some(false), Some(false), Some(false)));
        let o = encryption_info_with(&qpdf, &s(&restreint), "chef").unwrap();
        assert_eq!(o["ownerSupplied"], true);
        assert_eq!(encryption_info_with(&qpdf, &s(&restreint), "faux"), Err("MOT_DE_PASSE_INVALIDE".into()));
        // réenregistrement avec les droits relus : les restrictions sont toujours là
        let copie = d.join("copie.pdf");
        enc("lecteur", "chef", if i["print"] == true { "full" } else { "none" }, if i["copy"] == true { "y" } else { "n" }, if i["modify"] == true { "all" } else { "none" }, &copie);
        let j = encryption_info_with(&qpdf, &s(&copie), "lecteur").unwrap();
        assert_eq!((j["print"].as_bool(), j["copy"].as_bool(), j["modify"].as_bool()), (Some(false), Some(false), Some(false)));
        // sans restriction
        let libre = d.join("libre.pdf");
        enc("x", "x", "full", "y", "all", &libre);
        let k = encryption_info_with(&qpdf, &s(&libre), "x").unwrap();
        assert_eq!((k["print"].as_bool(), k["copy"].as_bool(), k["modify"].as_bool()), (Some(true), Some(true), Some(true)));
    }

    // ---------------------------------------------------------------- tests consolidation v1 (lot 4)

    #[test]
    fn nettoyage_des_temporaires_anciens_seulement() {
        let base = app_temp_dir();
        let ancien = base.join("envoi").join(format!("vieux-{}.pdf", unique_suffix()));
        let recent = base.join("envoi").join(format!("recent-{}.pdf", unique_suffix()));
        let profil = base.join("lo-profile").join(format!("reglage-{}", unique_suffix()));
        for p in [&ancien, &recent, &profil] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let deux_jours = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
        for p in [&ancien, &profil] {
            std::fs::File::options().write(true).open(p).unwrap().set_modified(deux_jours).unwrap();
        }
        let legacy = std::env::temp_dir().join(format!("sxm-capture-{}.png", unique_suffix()));
        std::fs::write(&legacy, b"x").unwrap();
        std::fs::File::options().write(true).open(&legacy).unwrap().set_modified(deux_jours).unwrap();
        assert!(cleanup_temp(std::time::Duration::from_secs(24 * 3600)) >= 2);
        assert!(!ancien.exists(), "pièce jointe de plus de 24 h effacée");
        assert!(!legacy.exists(), "ancienne capture (version précédente) effacée");
        assert!(recent.exists(), "fichier récent conservé (mail peut-être encore ouvert)");
        assert!(profil.exists(), "profil LibreOffice conservé");
        let _ = std::fs::remove_file(&recent);
    }

    #[test]
    fn captures_et_dechiffrement_dans_le_dossier_prive() {
        #[cfg(not(target_os = "linux"))]
        assert!(capture_temp_path().starts_with(app_temp_dir()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(app_temp_dir()).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    // ---------------------------------------------------------------- tests consolidation v1 (lot 5)

    #[test]
    fn messagerie_par_defaut_mac_lue_dans_les_reglages() {
        let sortie = r#"(
    {
        LSHandlerPreferredVersions = { LSHandlerRoleAll = "-"; };
        LSHandlerRoleAll = "com.apple.safari";
        LSHandlerURLScheme = https;
    },
    {
        LSHandlerPreferredVersions = { LSHandlerRoleAll = "-"; };
        LSHandlerRoleAll = "com.microsoft.outlook";
        LSHandlerURLScheme = mailto;
    }
)"#;
        assert_eq!(parse_mailto_handler(sortie).as_deref(), Some("com.microsoft.outlook"));
        assert_eq!(parse_mailto_handler("( )"), None);
    }

    #[test]
    fn fichiers_ouverts_avant_l_interface_sont_gardes() {
        {
            let mut p = PENDING_OPEN.lock().unwrap();
            *p = (false, vec!["/Users/utilisateur/contrat.pdf".into()]);
        }
        let args = startup_args();
        assert!(args.contains(&"/Users/utilisateur/contrat.pdf".to_string()));
        let p = PENDING_OPEN.lock().unwrap();
        assert!(p.0, "interface marquée prête");
        assert!(p.1.is_empty(), "liste vidée après remise à l'interface");
    }
}

/// Lit la copie de secours .bak sans rien modifier (pour la vérifier avant restauration).
#[tauri::command]
async fn data_read_backup(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_data_lock(|| std::fs::read_to_string(f.with_extension("json.bak")).map_err(|_| "Aucune copie de secours disponible.".to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remplace le fichier de données par sa copie de secours .bak, si elle est valide. Renvoie le contenu restauré.
#[tauri::command]
async fn data_restore_backup(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| restore_backup_file(&f))).await.map_err(|e| e.to_string())?
}

/// Met de côté un fichier de données illisible (sans le supprimer) pour repartir proprement.
#[tauri::command]
async fn data_quarantine(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| quarantine_file(&f))).await.map_err(|e| e.to_string())?
}

/// Déplace le fichier vers un nom unique, sans jamais écraser une copie déjà mise de côté.
fn quarantine_file(f: &Path) -> Result<String, String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut dest = f.with_file_name(format!("sxm-pdf-donnees.illisible-{ts}.json"));
    let mut n = 1;
    while dest.exists() {
        dest = f.with_file_name(format!("sxm-pdf-donnees.illisible-{ts}-{n}.json"));
        n += 1;
    }
    std::fs::rename(f, &dest).map_err(|e| format!("Impossible de mettre de côté le fichier : {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Restauration depuis le .bak : refusée si le .bak est absent, illisible, de structure incorrecte ou d'un
/// format plus récent. Dans ce cas le fichier principal n'est pas touché.
fn restore_backup_file(f: &Path) -> Result<String, String> {
    restore_backup_file_with(f, replace_file)
}

fn restore_backup_file_with<R>(f: &Path, rename: R) -> Result<String, String>
where
    R: Fn(&Path, &Path) -> std::io::Result<()>,
{
    let bak = f.with_extension("json.bak");
    let s = std::fs::read_to_string(&bak).map_err(|_| "Aucune copie de secours disponible.".to_string())?;
    parse_valid(&s).map_err(|e| format!("La copie de secours est invalide ou incompatible ({e}). Rien n'a été modifié."))?;
    // On n'écrase pas le .bak avec le fichier actuel (qui peut être celui qu'on écarte).
    save_json_file_with(f, &s, false, rename)?;
    Ok(s)
}

#[tauri::command]
fn data_path(app: tauri::AppHandle) -> Result<String, String> {
    data_file(&app).map(|p| p.to_string_lossy().to_string())
}

/// Indique quels outils externes sont présents (LibreOffice, qpdf).
#[tauri::command]
fn check_tools(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "libreoffice": find_soffice(&app).is_some(), "qpdf": find_qpdf(&app).is_some() })
}

/// Dossier temporaire pour les fichiers à envoyer / imprimer.
#[tauri::command]
fn temp_path(name: String) -> String {
    let dir = app_temp_dir().join("envoi");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(name.replace(['/', '\\', ':'], "_")).to_string_lossy().to_string()
}

/// Nom du fichier .desktop installé par le paquet (ex. « SXM PDF.desktop »).
#[cfg(target_os = "linux")]
fn find_desktop_id() -> Result<String, String> {
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
fn pin_app() -> Result<String, String> {
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
fn set_default_pdf() -> Result<(), String> {
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
fn mac_menu(app: &tauri::App) -> tauri::Result<()> {
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Une seule fenêtre : un nouveau lancement transmet ses arguments.
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            let _ = app.emit("sxm-args", args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            mac_menu(_app)?;
            // Fichiers temporaires de plus de 24 h effacés en arrière-plan
            std::thread::spawn(|| cleanup_temp(std::time::Duration::from_secs(24 * 3600)));
            Ok(())
        })
        .on_menu_event(|app, ev| {
            // « Quitter » (Cmd+Q) passe par la fermeture de la fenêtre : l'interface demande alors
            // d'enregistrer les documents modifiés, comme avec le bouton rouge.
            if ev.id().as_ref() == "sxm-quit" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            startup_args,
            read_bytes,
            write_bytes,
            office_convert,
            unique_path,
            capture_screen,
            print_window,
            set_default_pdf,
            pdf_encrypt,
            pdf_decrypt,
            pdf_encryption_info,
            remove_temp,
            send_mail,
            pin_app,
            data_load,
            data_save,
            data_path,
            data_restore_backup,
            data_read_backup,
            data_quarantine,
            check_tools,
            temp_path
        ])
        .build(tauri::generate_context!())
        .expect("Erreur au démarrage de SXM PDF")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                files_opened(_app, urls);
            }
        });
}
