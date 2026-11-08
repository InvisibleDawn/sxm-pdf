//! Conversions hors ligne avec LibreOffice (une à la fois, délai maximal, dossier propre).
#![allow(unused_imports)]
use crate::*;

/// Cherche LibreOffice : d'abord la copie embarquée, puis le système.
pub(crate) fn find_soffice(app: &tauri::AppHandle) -> Option<PathBuf> {
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
pub(crate) static CONVERT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Durée maximale d'une conversion : au-delà, LibreOffice est arrêté.
pub(crate) const CONVERT_TIMEOUT_S: u64 = 120;

/// Conversion hors ligne via LibreOffice (Office → PDF, ou PDF → Word avec infilter).
/// Chaque conversion écrit dans son propre dossier : un ancien résultat portant le même nom
/// ne peut jamais être ouvert à la place du bon document.
#[tauri::command]
pub(crate) async fn office_convert(
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

pub(crate) fn convert_with(soffice: &Path, path: &str, to: &str, infilter: Option<&str>, timeout_s: u64) -> Result<String, String> {
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
