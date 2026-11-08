//! Protection par mot de passe avec qpdf (arguments par fichier privé, droits conservés).
#![allow(unused_imports)]
use crate::*;

/// Cherche qpdf : copie embarquée puis système.
pub(crate) fn find_qpdf(app: &tauri::AppHandle) -> Option<PathBuf> {
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

pub(crate) fn run_qpdf(app: &tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let qpdf = find_qpdf(app).ok_or("qpdf est introuvable. Sous Fedora : sudo dnf install qpdf")?;
    run_qpdf_bin(&qpdf, args)
}

pub(crate) fn run_qpdf_bin(qpdf: &Path, args: Vec<String>) -> Result<(), String> {
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
pub(crate) fn write_private_argfile(args: &[String]) -> Result<PathBuf, String> {
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

/// Protège un PDF par mot de passe (AES-256). input peut être égal à output.
#[tauri::command]
pub(crate) async fn pdf_encrypt(
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
pub(crate) fn encrypt_with(qpdf: &Path, mut args: Vec<String>, input: &str, output: &str) -> Result<(), String> {
    if input == output {
        // qpdf écrit lui-même dans un temporaire puis remplace le fichier
        args.push("--replace-input".into());
        return run_qpdf_bin(qpdf, args);
    }
    let dest = PathBuf::from(output);
    remove_stale_siblings(&dest);
    let tmp = PathBuf::from(format!("{}.{}", sibling_tmp(&dest).to_string_lossy(), random_hex(8)));
    if tmp.exists() || std::fs::symlink_metadata(&tmp).is_ok() {
        return Err("Fichier temporaire déjà présent".into());
    }
    args.push(tmp.to_string_lossy().to_string());
    let res = run_qpdf_bin(qpdf, args).and_then(|_| replace_file(&tmp, &dest).map_err(|e| format!("Remplacement impossible : {e}")));
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Retire la protection d'un PDF (mot de passe requis). Renvoie le chemin du PDF déchiffré.
#[tauri::command]
pub(crate) async fn pdf_decrypt(app: tauri::AppHandle, input: String, password: String) -> Result<String, String> {
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
pub(crate) async fn pdf_encryption_info(app: tauri::AppHandle, input: String, password: String) -> Result<serde_json::Value, String> {
    let qpdf = find_qpdf(&app).ok_or("qpdf est introuvable.")?;
    tauri::async_runtime::spawn_blocking(move || encryption_info_with(&qpdf, &input, &password))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn encryption_info_with(qpdf: &Path, input: &str, password: &str) -> Result<serde_json::Value, String> {
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

pub(crate) fn parse_encryption_info(text: &str) -> serde_json::Value {
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
