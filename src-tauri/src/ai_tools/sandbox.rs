use std::path::{Path, PathBuf};

/// Resolve `requested` as a path inside `root`, canonicalising the result and
/// guaranteeing it is a descendant of `root`.
///
/// Resolution rules:
/// - If `requested` is empty, returns `root` itself.
/// - If `requested` starts with `/` or a Windows drive letter (e.g. `C:\` or
///   `C:/`), the leading `/` is stripped and the remainder is joined onto `root`.
///   This lets the model address absolute paths while still keeping them inside
///   the workspace.
/// - Otherwise `requested` is treated as workspace-relative and joined onto `root`.
///
/// After joining, both `root` and the joined path are canonicalised (resolving
/// `..`, symlinks, and `.`) and the result must be a descendant of the canonical
/// root, otherwise `PathOutsideWorkspace` is returned.
pub fn resolve_in_workspace(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();

    let joined = if requested.is_empty() {
        root.to_path_buf()
    } else {
        let stripped = strip_leading_slash_or_drive(requested);
        root.join(stripped)
    };

    resolve_in_workspace_strict_impl(root, &joined)
}

/// Core resolver: canonicalises the nearest existing ancestor of `joined` and
/// verifies the result is a descendant of `root`. Handles paths that do not yet
/// exist (e.g. files about to be written) and absolute paths that cannot be
/// canonicalised (e.g. a missing drive), rejecting the latter as
/// `PathOutsideWorkspace`.
fn resolve_in_workspace_strict_impl(root: &Path, joined: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workspace root: {e}"))?;

    // The requested path may not exist yet (e.g. a file we are about to write),
    // so canonicalise the nearest existing ancestor and re-attach the remaining
    // components. This still resolves `..` and symlinks in the existing prefix.
    let (existing_ancestor, suffix) = nearest_existing(joined);
    match existing_ancestor.canonicalize() {
        Ok(canonical_ancestor) => {
            let canonical = canonical_ancestor.join(&suffix);
            if canonical != canonical_root && !canonical.starts_with(&canonical_root) {
                return Err("PathOutsideWorkspace".to_string());
            }
            Ok(canonical)
        }
        Err(_) => {
            // Ancestor doesn't exist (e.g. missing drive). Reject absolute paths
            // that are clearly outside the workspace; relative paths are allowed
            // (they will be created under root).
            if joined.is_absolute() && !joined.starts_with(&canonical_root) {
                return Err("PathOutsideWorkspace".to_string());
            }
            Ok(joined.to_path_buf())
        }
    }
}

/// Walk up from `path` until an existing directory/file is found. Returns the
/// existing ancestor and the (possibly empty) suffix of components below it.
fn nearest_existing(path: &Path) -> (PathBuf, PathBuf) {
    let mut current = path.to_path_buf();
    let mut suffix = PathBuf::new();
    while !current.as_os_str().is_empty() {
        if current.exists() {
            return (current, suffix);
        }
        if let Some(parent) = current.parent() {
            // Push the current final component onto the suffix (front).
            if let Some(name) = current.file_name() {
                let mut new_suffix = PathBuf::from(name);
                new_suffix.push(&suffix);
                suffix = new_suffix;
            }
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    (path.to_path_buf(), suffix)
}

/// Normalise the leading separator of `requested` so it can be joined onto the
/// workspace root.
///
/// - A Windows drive-letter path (`C:\foo`, `C:/foo`) is returned unchanged — it
///   is already absolute and will be checked against the workspace root below.
/// - A leading `/` or `\` (Unix-style absolute) is stripped so the remainder is
///   treated as workspace-relative (joined onto `root`).
/// - Anything else is returned unchanged (workspace-relative).
fn strip_leading_slash_or_drive(p: &str) -> &str {
    // Drive letter form: "C:\foo" or "C:/foo" — leave absolute.
    if p.len() >= 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic() {
        return p;
    }
    p.trim_start_matches(['/', '\\'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Build a temp workspace with a couple of nested files and a symlink.
    fn make_workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join("sub/deep")).unwrap();
        fs::write(root.join("a.txt"), b"hello").unwrap();
        fs::write(root.join("sub/deep/b.txt"), b"world").unwrap();
        // Symlink inside the workspace pointing at a file inside it.
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_file(root.join("a.txt"), root.join("link.txt"));
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(root.join("a.txt"), root.join("link.txt"));
        (dir, root)
    }

    #[test]
    fn accepts_nested_descendant() {
        let (_d, root) = make_workspace();
        let p = resolve_in_workspace(&root, "sub/deep/b.txt").unwrap();
        assert!(p.ends_with("b.txt"));
        assert!(p.starts_with(&root));
    }

    #[test]
    fn accepts_root_itself() {
        let (_d, root) = make_workspace();
        let p = resolve_in_workspace(&root, "").unwrap();
        assert_eq!(p, root.canonicalize().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn accepts_absolute_path_inside_workspace() {
        let (_d, root) = make_workspace();
        let abs = root.join("a.txt");
        let p = resolve_in_workspace(&root, &abs.to_string_lossy()).unwrap();
        assert_eq!(p, abs.canonicalize().unwrap());
    }

    #[test]
    fn rejects_parent_escape() {
        let (_d, root) = make_workspace();
        let res = resolve_in_workspace(&root, "../../etc/passwd");
        assert_eq!(res, Err("PathOutsideWorkspace".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let (_d, root) = make_workspace();
        let res = resolve_in_workspace(&root, "C:/Windows/System32/cmd.exe");
        assert_eq!(res, Err("PathOutsideWorkspace".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_drive_letter_outside_workspace() {
        let (_d, root) = make_workspace();
        let res = resolve_in_workspace(&root, "D:/secret.txt");
        assert_eq!(res, Err("PathOutsideWorkspace".to_string()));
    }

    #[test]
    fn canonicalises_symlink_inside_workspace() {
        let (_d, root) = make_workspace();
        // The symlink target is inside the workspace, so it must be accepted.
        let p = resolve_in_workspace(&root, "link.txt");
        assert!(p.is_ok(), "symlink inside workspace should resolve: {p:?}");
    }
}
