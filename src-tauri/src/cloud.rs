//! Dossiers synchronisés OneDrive et Proton Drive (boutons « Ouvrir depuis… »).
//! SXM PDF ne parle à aucun service en ligne : il repère seulement les dossiers que les applications
//! OneDrive / Proton Drive synchronisent déjà sur l'ordinateur.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default, Debug, PartialEq)]
pub(crate) struct CloudFolders {
    pub onedrive: Vec<String>,
    pub proton: Vec<String>,
}

/// Noms de dossiers reconnus dans un répertoire (dossier personnel, ~/Library/CloudStorage…).
fn matching_children(dir: &Path, prefixes: &[&str]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            prefixes.iter().any(|p| n.starts_with(&p.to_lowercase()))
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn push_unique(list: &mut Vec<String>, p: PathBuf) {
    if p.is_dir() {
        let s = p.to_string_lossy().to_string();
        if !list.contains(&s) {
            list.push(s);
        }
    }
}

/// Détection, séparée de l'environnement réel pour pouvoir être testée.
pub(crate) fn detect(home: &Path, env: &dyn Fn(&str) -> Option<String>, os: &str) -> CloudFolders {
    let mut f = CloudFolders::default();
    match os {
        "windows" => {
            // Variables posées par l'application OneDrive (compte pro, compte perso).
            for v in ["OneDriveCommercial", "OneDriveConsumer", "OneDrive"] {
                if let Some(p) = env(v).filter(|s| !s.is_empty()) {
                    push_unique(&mut f.onedrive, PathBuf::from(p));
                }
            }
            for p in matching_children(home, &["OneDrive"]) {
                push_unique(&mut f.onedrive, p);
            }
            for p in matching_children(home, &["Proton Drive", "ProtonDrive"]) {
                push_unique(&mut f.proton, p);
            }
        }
        "macos" => {
            let cs = home.join("Library").join("CloudStorage");
            for p in matching_children(&cs, &["OneDrive"]) {
                push_unique(&mut f.onedrive, p);
            }
            for p in matching_children(&cs, &["ProtonDrive", "Proton Drive"]) {
                push_unique(&mut f.proton, p);
            }
            push_unique(&mut f.onedrive, home.join("OneDrive"));
        }
        _ => {
            // Linux : pas d'application officielle ; dossiers habituels des outils de synchronisation.
            push_unique(&mut f.onedrive, home.join("OneDrive"));
            for p in matching_children(home, &["Proton Drive", "ProtonDrive"]) {
                push_unique(&mut f.proton, p);
            }
        }
    }
    f
}

fn current_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Dossiers OneDrive / Proton Drive présents sur cet ordinateur.
#[tauri::command]
pub(crate) fn cloud_folders() -> CloudFolders {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default();
    detect(&home, &|k| std::env::var(k).ok(), current_os())
}

/// Vrai si le dossier existe (dernier dossier utilisé, dossier choisi à la main).
#[tauri::command]
pub(crate) fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sxm-cloud-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn windows_variables_et_proton() {
        let h = tmp("win");
        let pro = h.join("OneDrive - SOLCER");
        std::fs::create_dir_all(&pro).unwrap();
        std::fs::create_dir_all(h.join("OneDrive")).unwrap();
        std::fs::create_dir_all(h.join("Proton Drive")).unwrap();
        std::fs::create_dir_all(h.join("Documents")).unwrap();
        let p = pro.to_string_lossy().to_string();
        let env = move |k: &str| if k == "OneDriveCommercial" { Some(p.clone()) } else { None };
        let f = detect(&h, &env, "windows");
        assert_eq!(f.onedrive[0], pro.to_string_lossy());          // compte pro en premier
        assert_eq!(f.onedrive.len(), 2);                             // + OneDrive perso, sans doublon
        assert_eq!(f.proton, vec![h.join("Proton Drive").to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn macos_cloudstorage() {
        let h = tmp("mac");
        let cs = h.join("Library").join("CloudStorage");
        std::fs::create_dir_all(cs.join("OneDrive-Personnel")).unwrap();
        std::fs::create_dir_all(cs.join("ProtonDrive-moi@proton.me-folder")).unwrap();
        std::fs::create_dir_all(cs.join("GoogleDrive-x")).unwrap();
        let f = detect(&h, &|_| None, "macos");
        assert_eq!(f.onedrive.len(), 1);
        assert_eq!(f.proton.len(), 1);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn rien_d_installe() {
        let h = tmp("vide");
        assert_eq!(detect(&h, &|_| Some("C:\\inexistant".into()), "windows"), CloudFolders::default());
        assert_eq!(detect(&h, &|_| None, "linux"), CloudFolders::default());
        let _ = std::fs::remove_dir_all(&h);
    }
}
