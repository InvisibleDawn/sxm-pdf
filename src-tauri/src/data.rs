//! Données utilisateur (signatures, tampons, profils) : fichier JSON, copie .bak, verrou, restauration.
#![allow(unused_imports)]
use crate::*;

/// Fichier de données de l'utilisateur (signatures, tampons, profils, modèles).
/// Linux : ~/.config/com.sxm.pdf/ · Windows : %APPDATA%\\com.sxm.pdf\\ · macOS : ~/Library/Application Support/com.sxm.pdf/
pub(crate) fn data_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

pub(crate) static DATA_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Exécute f en tenant le verrou des données (un verrou empoisonné par un panic est récupéré).
pub(crate) fn with_data_lock<T>(f: impl FnOnce() -> T) -> T {
    let _g = DATA_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    f()
}

/// Version du format du fichier de données. Un fichier d'une version plus récente est refusé.
pub(crate) const DATA_FORMAT: u64 = 1;

#[tauri::command]
pub(crate) async fn data_load(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| load_json_file(&f))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn data_save(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| save_json_file(&f, &content))).await.map_err(|e| e.to_string())?
}

/// Contrôle de structure du fichier de données (types de chaque rubrique, version du format).
/// Les contrôles détaillés champ par champ sont faits en plus côté interface avant un import
/// ou une restauration ; ici on garantit qu'aucun fichier de forme incorrecte n'est écrit ni restauré.
pub(crate) fn validate_data(v: &serde_json::Value) -> Result<(), String> {
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

pub(crate) fn parse_valid(s: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("JSON invalide : {e}"))?;
    validate_data(&v)?;
    Ok(v)
}

/// Lit le fichier de données. S'il est absent : « {} ». S'il est illisible, corrompu ou de structure
/// incorrecte, on se rabat sur la copie de secours .bak si elle est valide.
pub(crate) fn load_json_file(f: &Path) -> Result<String, String> {
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

/// Sauvegarde sûre, identique sous Linux, macOS et Windows.
pub(crate) fn save_json_file(f: &Path, content: &str) -> Result<(), String> {
    save_json_file_with(f, content, true, replace_file)
}

/// Même chose, avec la fonction de remplacement injectable (tests d'échec) et le choix de mettre à jour
/// ou non la copie .bak. Étapes : validation → .bak atomique de la version actuelle si elle est valide →
/// écriture atomique du nouveau contenu. Un échec à n'importe quelle étape laisse le fichier principal intact.
pub(crate) fn save_json_file_with<R>(f: &Path, content: &str, update_bak: bool, rename: R) -> Result<(), String>
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

/// Lit la copie de secours .bak sans rien modifier (pour la vérifier avant restauration).
#[tauri::command]
pub(crate) async fn data_read_backup(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_data_lock(|| std::fs::read_to_string(f.with_extension("json.bak")).map_err(|_| "Aucune copie de secours disponible.".to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remplace le fichier de données par sa copie de secours .bak, si elle est valide. Renvoie le contenu restauré.
#[tauri::command]
pub(crate) async fn data_restore_backup(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| restore_backup_file(&f))).await.map_err(|e| e.to_string())?
}

/// Met de côté un fichier de données illisible (sans le supprimer) pour repartir proprement.
#[tauri::command]
pub(crate) async fn data_quarantine(app: tauri::AppHandle) -> Result<String, String> {
    let f = data_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || with_data_lock(|| quarantine_file(&f))).await.map_err(|e| e.to_string())?
}

/// Déplace le fichier vers un nom unique, sans jamais écraser une copie déjà mise de côté.
pub(crate) fn quarantine_file(f: &Path) -> Result<String, String> {
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
pub(crate) fn restore_backup_file(f: &Path) -> Result<String, String> {
    restore_backup_file_with(f, replace_file)
}

pub(crate) fn restore_backup_file_with<R>(f: &Path, rename: R) -> Result<String, String>
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
pub(crate) fn data_path(app: tauri::AppHandle) -> Result<String, String> {
    data_file(&app).map(|p| p.to_string_lossy().to_string())
}
