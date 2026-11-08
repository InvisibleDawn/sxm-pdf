#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Manager};

mod capture;
mod convert;
mod data;
mod files;
mod qpdf;
mod system;
pub(crate) use capture::*;
pub(crate) use convert::*;
pub(crate) use data::*;
pub(crate) use files::*;
pub(crate) use qpdf::*;
pub(crate) use system::*;

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
        FAIL_TMP_WRITE.with(|x| x.set(true)); // disque plein, droits… : le temporaire ne peut pas être écrit
        let r = save_json_file(&f, "{\"v\":2}");
        FAIL_TMP_WRITE.with(|x| x.set(false));
        assert!(r.is_err());
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
        FAIL_TMP_WRITE.with(|x| x.set(true)); // écriture du temporaire impossible
        let r = write_file_safely(&f, b"NOUVEAU");
        FAIL_TMP_WRITE.with(|x| x.set(false));
        assert!(r.is_err());
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

    // ---------------------------------------------------------------- tests consolidation v1 (lot 6)

    #[test]
    fn seuls_les_liens_web_et_mail_sont_ouverts() {
        assert!(is_safe_url("https://www.service-public.fr/particuliers/vosdroits/F2258"));
        assert!(is_safe_url("mailto:rh@exemple.fr?subject=Contrat"));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "smb://serveur/partage", "https://a.fr/\" & calc", "C:\\Windows\\system32\\calc.exe", "https://x.fr/a b"] {
            assert!(!is_safe_url(bad), "{bad} doit être refusé");
        }
    }

    // ---------------------------------------------------------------- tests consolidation v2 (lot A)

    #[test]
    fn temporaire_jamais_previsible_ni_ecrase() {
        let d = dir("aleat");
        let f = d.join("contrat.pdf");
        std::fs::write(&f, b"V1").unwrap();
        // un fichier piège au nom « classique » du temporaire n'est ni lu, ni écrasé, ni suivi
        let piege = sibling_tmp(&f);
        std::fs::write(&piege, b"PIEGE").unwrap();
        write_file_safely(&f, b"V2").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"V2");
        assert_eq!(std::fs::read(&piege).unwrap(), b"PIEGE");
        let a = random_hex(8);
        assert_eq!(a.len(), 16);
        assert_ne!(a, random_hex(8));
    }

    #[cfg(unix)]
    #[test]
    fn lien_symbolique_piege_non_suivi() {
        let d = dir("lien");
        let cible = d.join("cible-sensible.txt");
        std::fs::write(&cible, b"NE PAS TOUCHER").unwrap();
        let f = d.join("doc.pdf");
        std::fs::write(&f, b"V1").unwrap();
        // lien posé à l'avance par un tiers, même au nom exact d'un futur temporaire : create_new refuse
        let fake = PathBuf::from(format!("{}.{}", sibling_tmp(&f).to_string_lossy(), "0000000000000000"));
        std::os::unix::fs::symlink(&cible, &fake).unwrap();
        write_file_safely(&f, b"V2").unwrap();
        assert_eq!(std::fs::read(&cible).unwrap(), b"NE PAS TOUCHER");
        // un dossier temporaire qui est un lien n'est jamais accepté comme privé
        let lien_dossier = d.join("faux-dossier");
        std::os::unix::fs::symlink(&d, &lien_dossier).unwrap();
        assert!(!is_private_dir(&lien_dossier));
    }

    #[cfg(unix)]
    #[test]
    fn droits_du_document_conserves_et_dossier_temporaire_prive() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("droitsdoc");
        let f = d.join("partage.pdf");
        std::fs::write(&f, b"V1").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_file_safely(&f, b"V2").unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o640);
        let t = app_temp_dir();
        assert!(is_private_dir(&t), "dossier temporaire privé : {t:?}");
        #[cfg(target_os = "linux")]
        assert!(!t.starts_with("/tmp") || std::env::var_os("XDG_RUNTIME_DIR").is_none() && std::env::var_os("HOME").is_none(),
            "sous Linux, jamais dans /tmp partagé : {t:?}");
        // dossier d'un autre propriétaire ou ouvert aux autres : refusé
        let ouvert = d.join("ouvert");
        std::fs::create_dir(&ouvert).unwrap();
        std::fs::set_permissions(&ouvert, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!is_private_dir(&ouvert));
    }

    #[test]
    fn restes_d_un_enregistrement_interrompu_effaces() {
        let d = dir("restes");
        let f = d.join("doc.pdf");
        std::fs::write(&f, b"V1").unwrap();
        let vieux = PathBuf::from(format!("{}.aaaa", sibling_tmp(&f).to_string_lossy()));
        let recent = PathBuf::from(format!("{}.bbbb", sibling_tmp(&f).to_string_lossy()));
        std::fs::write(&vieux, b"x").unwrap();
        std::fs::write(&recent, b"x").unwrap();
        let il_y_a_1h = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&vieux).unwrap().set_modified(il_y_a_1h).unwrap();
        write_file_safely(&f, b"V2").unwrap();
        assert!(!vieux.exists(), "reste d'une coupure effacé");
        assert!(recent.exists(), "enregistrement peut-être en cours : conservé");
    }

    #[test]
    fn temporaires_d_une_operation_effaces_au_demarrage() {
        let base = app_temp_dir();
        let dech = base.join(format!("dechiffre-{}.pdf", unique_suffix()));
        let args = base.join(format!("qpdf-{}.args", unique_suffix()));
        let envoi = base.join("envoi").join(format!("Contrat-{}.pdf", unique_suffix()));
        std::fs::create_dir_all(envoi.parent().unwrap()).unwrap();
        for p in [&dech, &args, &envoi] { std::fs::write(p, b"x").unwrap(); }
        cleanup_temp(std::time::Duration::from_secs(24 * 3600));
        assert!(!dech.exists() && !args.exists(), "copie déchiffrée et arguments effacés même récents");
        assert!(envoi.exists(), "pièce jointe récente conservée");
        let _ = std::fs::remove_file(&envoi);
    }

    // ---------------------------------------------------------------- tests consolidation v2 (lot D)

    #[test]
    fn ecritures_simultanees_jamais_de_fichier_melange() {
        let d = dir("concur");
        let f = d.join("partage.pdf");
        std::fs::write(&f, vec![b'0'; 200_000]).unwrap();
        for _round in 0..5 {
            let handles: Vec<_> = (1..=8u8)
                .map(|k| {
                    let f = f.clone();
                    std::thread::spawn(move || {
                        let payload = vec![b'0' + k; 200_000 + k as usize * 1000];
                        write_file_safely(&f, &payload)
                    })
                })
                .collect();
            let ok = handles.into_iter().map(|h| h.join().unwrap()).filter(|r| r.is_ok()).count();
            assert!(ok >= 1, "au moins une écriture aboutit");
            // le fichier est toujours entièrement l'une des versions, jamais un mélange ni tronqué
            let content = std::fs::read(&f).unwrap();
            let k = content[0];
            assert!(content.iter().all(|&b| b == k), "contenu homogène");
            assert_eq!(content.len(), 200_000 + (k - b'0') as usize * 1000, "longueur complète");
        }
        let restes = std::fs::read_dir(&d).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("sxm-tmp")).count();
        assert_eq!(restes, 0, "aucun fichier temporaire laissé");
    }
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
            file_size,
            capture_screen,
            print_window,
            set_default_pdf,
            pdf_encrypt,
            pdf_decrypt,
            pdf_encryption_info,
            remove_temp,
            send_mail,
            pin_app,
            open_external,
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
