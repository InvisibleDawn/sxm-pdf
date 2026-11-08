//! Fichiers : lecture/écriture sûre des PDF, dossier temporaire privé, noms uniques, nettoyage.
#![allow(unused_imports)]
use crate::*;

/// Lit un fichier et le renvoie en binaire brut (rapide pour les gros PDF).
#[tauri::command]
pub(crate) fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("Lecture impossible de {path} : {e}"))
}

/// Écrit un fichier ; le corps de la requête est le contenu binaire.
/// Écriture sûre : fichier temporaire dans le même dossier, forcé sur le disque, puis remplacement
/// atomique. Une coupure ou un disque plein pendant l'écriture laisse l'ancien fichier intact.
#[tauri::command]
pub(crate) fn write_bytes(request: tauri::ipc::Request) -> Result<(), String> {
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
pub(crate) fn sibling_tmp(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.sxm-tmp"))
}

pub(crate) fn write_file_safely(path: &Path, data: &[u8]) -> Result<(), String> {
    remove_stale_siblings(path);
    atomic_write(path, &sibling_tmp(path), data, &replace_file)
}

/// Restes d'un enregistrement interrompu (coupure, plantage) à côté du document : effacés s'ils ont
/// plus de 10 minutes (un enregistrement en cours n'est jamais touché). L'original n'a pas été modifié.
pub(crate) fn remove_stale_siblings(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return };
    let prefix = format!(".{}.sxm-tmp", name.to_string_lossy());
    let Ok(rd) = std::fs::read_dir(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if !n.starts_with(&prefix) {
            continue;
        }
        let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
        let age = m.modified().ok().and_then(|t| std::time::SystemTime::now().duration_since(t).ok()).unwrap_or_default();
        if m.is_file() && age.as_secs() >= 600 {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

pub(crate) fn urlencode_decode(s: &str) -> String {
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

/// Taille d'un fichier en octets (vérifiée avant d'ouvrir un très gros PDF).
#[tauri::command]
pub(crate) fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Chemin libre : « nom.pdf » s'il n'existe pas, sinon « nom (2).pdf », « nom (3).pdf »…
#[tauri::command]
pub(crate) fn unique_path(path: String) -> String {
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

/// Octets aléatoires sûrs (aléa du système) en hexadécimal.
pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if getrandom::fill(&mut b).is_err() {
        // Ne devrait jamais arriver ; repli non prévisible pour un autre processus
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b = (t ^ ((std::process::id() as u128) << 64)).to_le_bytes()[..n.min(16)].to_vec();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Dossier temporaire de SXM PDF, propre à l'utilisateur.
/// - Linux : dossier d'exécution de l'utilisateur ($XDG_RUNTIME_DIR, en mémoire, effacé à la
///   déconnexion), sinon ~/.cache/com.sxm.pdf/tmp — jamais dans /tmp partagé entre utilisateurs.
/// - macOS et Windows : dossier temporaire du système, déjà propre à chaque utilisateur.
/// Le dossier est vérifié : vrai dossier (pas un lien), appartenant à l'utilisateur, privé (0700).
/// En cas de doute, un dossier neuf au nom aléatoire est créé à la place.
pub(crate) fn app_temp_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let preferred = preferred_temp_base().join("sxm-pdf");
        if prepare_private_dir(&preferred).is_ok() {
            return preferred;
        }
        let fallback = preferred_temp_base().join(format!("sxm-pdf-{}", random_hex(8)));
        let _ = prepare_private_dir(&fallback);
        fallback
    })
    .clone()
}

pub(crate) fn preferred_temp_base() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
            if rt.is_absolute() && is_private_dir(&rt) {
                return rt;
            }
        }
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let c = home.join(".cache").join("com.sxm.pdf");
            if std::fs::create_dir_all(&c).is_ok() {
                return c;
            }
        }
    }
    std::env::temp_dir()
}

/// Crée (si besoin) et vérifie un dossier privé : pas un lien symbolique, propriétaire = utilisateur,
/// aucun droit pour les autres.
pub(crate) fn prepare_private_dir(dir: &Path) -> Result<(), String> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    match b.create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    if is_private_dir(dir) { Ok(()) } else { Err("dossier temporaire non sûr".into()) }
}

#[cfg(unix)]
extern "C" {
    pub(crate) fn geteuid() -> u32;
}

pub(crate) fn is_private_dir(dir: &Path) -> bool {
    let Ok(m) = std::fs::symlink_metadata(dir) else { return false };
    if !m.is_dir() || m.file_type().is_symlink() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.uid() == unsafe { geteuid() } && m.mode() & 0o077 == 0
    }
    #[cfg(not(unix))]
    {
        true // Windows : %TEMP% est dans le profil de l'utilisateur (droits NTFS du profil)
    }
}

/// Nettoyage au démarrage : fichiers temporaires de SXM PDF de plus de `max_age` (pièces jointes
/// envoyées, conversions, captures, copies déchiffrées), et anciens dossiers des versions précédentes.
/// Le profil LibreOffice est conservé (il accélère les conversions).
pub(crate) fn cleanup_temp(max_age: std::time::Duration) -> usize {
    let now = std::time::SystemTime::now();
    // Fichiers d'une seule opération (copie déchiffrée, chiffrement, arguments qpdf, capture,
    // conversion) : au démarrage aucune opération n'est en cours, ils sont effacés quel que soit leur âge.
    // Les pièces jointes envoyées (envoi/) attendent 24 h : le message peut être encore ouvert.
    let one_shot = |p: &Path| {
        let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        ["dechiffre-", "chiffrement-", "qpdf-", "capture-"].iter().any(|x| n.starts_with(x))
            || p.components().any(|c| c.as_os_str() == "conversions")
    };
    let old = |p: &Path| {
        one_shot(p)
            || std::fs::symlink_metadata(p)
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
    // v1.1.0-test (Linux) : ancien dossier partagé /tmp/sxm-pdf, effacé s'il nous appartient
    let shared = tmp.join("sxm-pdf");
    if shared != base && is_private_dir(&shared) && std::fs::remove_dir_all(&shared).is_ok() {
        removed += 1;
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

pub(crate) fn unique_suffix() -> String {
    random_hex(12)
}

/// Supprime un fichier temporaire créé par SXM PDF (uniquement dans le dossier temporaire).
#[tauri::command]
pub(crate) fn remove_temp(path: String) {
    if is_in_temp(Path::new(&path)) {
        let _ = std::fs::remove_file(path);
    }
}

/// Vrai si le chemin, une fois résolu (liens et « .. » compris), est dans le dossier temporaire.
pub(crate) fn is_in_temp(p: &Path) -> bool {
    let Ok(file) = p.canonicalize() else { return false };
    if !file.is_file() || std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        return false;
    }
    [app_temp_dir(), std::env::temp_dir()].iter().filter_map(|d| d.canonicalize().ok()).any(|d| file.starts_with(d))
}

/// Remplacement atomique de `dst` par `src`, y compris lorsque `dst` existe déjà.
/// - Windows : MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) — appel explicite
///   (std::fs::rename fait déjà MOVEFILE_REPLACE_EXISTING ; WRITE_THROUGH garantit en plus que le
///   renommage est écrit sur le disque avant le retour). Si la destination est ouverte par un autre
///   programme, repli sur std::fs::rename (sémantique POSIX de Windows 10+). Aucune dépendance ajoutée.
/// - Linux / macOS : rename(2), atomique, puis synchronisation du dossier pour rendre le renommage durable.
pub(crate) fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
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

#[cfg(test)]
thread_local! {
    /// Tests : simule un échec d'écriture du fichier temporaire (disque plein, droits…).
    pub(crate) static FAIL_TMP_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Écrit `content` dans `path` de façon atomique (fichier .tmp + remplacement), avec réessais
/// si le fichier est momentanément verrouillé (antivirus, indexation, OneDrive…).
pub(crate) fn atomic_write<R>(path: &Path, tmp: &Path, content: &[u8], rename: &R) -> Result<(), String>
where
    R: Fn(&Path, &Path) -> std::io::Result<()>,
{
    use std::io::Write;
    // Nom réellement utilisé : préfixe donné + suffixe aléatoire (jamais prévisible, jamais partagé
    // entre deux enregistrements simultanés). create_new refuse un fichier ou un lien déjà présent.
    let tmp = &PathBuf::from(format!("{}.{}", tmp.to_string_lossy(), random_hex(8)));
    let write_tmp = || -> std::io::Result<()> {
        #[cfg(test)]
        if FAIL_TMP_WRITE.with(|f| f.get()) {
            return Err(std::io::Error::other("écriture du temporaire impossible (simulée)"));
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(tmp)?;
        file.write_all(content)?;
        file.flush()?;
        file.sync_all()?;
        // Les droits du fichier remplacé sont conservés (Linux/macOS ; Windows hérite du dossier)
        #[cfg(unix)]
        if let Ok(m) = std::fs::metadata(path) {
            std::fs::set_permissions(tmp, m.permissions())?;
        }
        Ok(())
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

/// Dossier temporaire pour les fichiers à envoyer / imprimer.
#[tauri::command]
pub(crate) fn temp_path(name: String) -> String {
    let dir = app_temp_dir().join("envoi");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(name.replace(['/', '\\', ':'], "_")).to_string_lossy().to_string()
}
