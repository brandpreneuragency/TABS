use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rand::RngCore;

#[derive(Clone, Debug)]
struct WorkspaceScope {
    run_id: String,
    workspace_id: String,
    canonical_root: PathBuf,
}

/// Process-local native authority for agent filesystem operations.
///
/// The frontend may register a user-connected root, but model-facing commands
/// receive only the resulting opaque identifier and a relative path.
#[derive(Default)]
pub struct WorkspaceScopeRegistry {
    scopes: Mutex<HashMap<String, WorkspaceScope>>,
}

impl WorkspaceScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        run_id: &str,
        workspace_id: &str,
        root: &Path,
    ) -> Result<String, String> {
        let canonical_root = canonical_workspace_root(root)?;
        let mut scopes = self.lock()?;
        if scopes
            .values()
            .any(|scope| scope.run_id == run_id && scope.workspace_id == workspace_id)
        {
            return Err("WorkspaceScopeAlreadyRegistered".to_string());
        }
        insert_random_scope(&mut scopes, run_id, workspace_id, canonical_root)
    }

    /// Restore a persisted run after process restart or replace its stale
    /// process-local registration. A fresh random identifier is always issued.
    pub fn reregister(
        &self,
        run_id: &str,
        workspace_id: &str,
        root: &Path,
    ) -> Result<String, String> {
        // Verify availability before invalidating a currently usable scope.
        let canonical_root = canonical_workspace_root(root)?;
        let mut scopes = self.lock()?;
        scopes.retain(|_, scope| scope.run_id != run_id || scope.workspace_id != workspace_id);
        insert_random_scope(&mut scopes, run_id, workspace_id, canonical_root)
    }

    pub fn revoke(&self, scope_id: &str) -> Result<bool, String> {
        Ok(self.lock()?.remove(scope_id).is_some())
    }

    pub fn root(&self, scope_id: &str) -> Result<PathBuf, String> {
        self.lock()?
            .get(scope_id)
            .map(|scope| scope.canonical_root.clone())
            .ok_or_else(|| "WorkspaceScopeUnavailable".to_string())
    }

    /// Resolve a normalized model path beneath the frozen canonical root.
    /// Existing ancestors are canonicalized so symlinks cannot escape.
    pub fn resolve(&self, scope_id: &str, relative_path: &str) -> Result<PathBuf, String> {
        let root = self.root(scope_id)?;
        let relative = normalize_relative(relative_path, true)?;
        resolve_beneath(&root, &relative)
    }

    /// Validate a glob pattern as relative before joining it to a scoped base.
    /// The canonical base is glob-escaped so workspace characters cannot
    /// change the match set.
    pub fn scoped_glob_pattern(
        &self,
        scope_id: &str,
        base_path: &str,
        pattern: &str,
    ) -> Result<String, String> {
        let base = self.resolve(scope_id, base_path)?;
        let normalized_pattern = normalize_relative(pattern, false)?;
        let escaped_base = escape_glob_metacharacters(&base.to_string_lossy().replace('\\', "/"));
        let pattern_value = normalized_pattern.to_string_lossy().replace('\\', "/");
        Ok(format!("{escaped_base}/{pattern_value}"))
    }

    /// Convert an existing search result to a normalized relative path, after
    /// canonical containment checking. Never return an outside absolute path.
    pub fn relative_search_result(
        &self,
        scope_id: &str,
        returned_path: &Path,
    ) -> Result<String, String> {
        let root = self.root(scope_id)?;
        let canonical = returned_path
            .canonicalize()
            .map_err(|_| "SearchResultUnavailable".to_string())?;
        if canonical != root && !canonical.starts_with(&root) {
            return Err("SearchResultOutsideWorkspace".to_string());
        }
        let relative = canonical
            .strip_prefix(&root)
            .map_err(|_| "SearchResultOutsideWorkspace".to_string())?;
        let value = relative
            .to_str()
            .ok_or_else(|| "SearchResultPathEncodingUnsupported".to_string())?
            .replace('\\', "/");
        normalize_relative(&value, true)?;
        Ok(value)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, WorkspaceScope>>, String> {
        self.scopes
            .lock()
            .map_err(|_| "WorkspaceScopeStateUnavailable".to_string())
    }
}

fn canonical_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|_| "WorkspaceRootUnavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("WorkspaceRootUnavailable".to_string());
    }
    Ok(canonical)
}

fn insert_random_scope(
    scopes: &mut HashMap<String, WorkspaceScope>,
    run_id: &str,
    workspace_id: &str,
    canonical_root: PathBuf,
) -> Result<String, String> {
    for _ in 0..8 {
        let mut random = [0_u8; 32];
        rand::rng().fill_bytes(&mut random);
        let scope_id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        if !scopes.contains_key(&scope_id) {
            scopes.insert(
                scope_id.clone(),
                WorkspaceScope {
                    run_id: run_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    canonical_root,
                },
            );
            return Ok(scope_id);
        }
    }
    Err("WorkspaceScopeIdGenerationFailed".to_string())
}

fn escape_glob_metacharacters(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '*' | '?' | '[' | ']' | '{' | '}' => {
                escaped.push('[');
                escaped.push(ch);
                escaped.push(']');
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn normalize_relative(value: &str, allow_empty: bool) -> Result<PathBuf, String> {
    if value.contains('\0') || value.contains('\\') {
        return Err("PathMustBeNormalizedRelative".to_string());
    }
    if value.is_empty() {
        return allow_empty
            .then(PathBuf::new)
            .ok_or_else(|| "PathMustBeNormalizedRelative".to_string());
    }
    if value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || (value.as_bytes().get(1) == Some(&b':') && value.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err("PathMustBeNormalizedRelative".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in value.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("PathMustBeNormalizedRelative".to_string());
        }
        normalized.push(component);
    }
    Ok(normalized)
}

fn resolve_beneath(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let joined = root.join(relative);
    let mut ancestor = joined.clone();
    let mut missing: Vec<OsString> = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| "PathOutsideWorkspace".to_string())?;
        missing.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "PathOutsideWorkspace".to_string())?
            .to_path_buf();
    }

    let mut resolved = ancestor
        .canonicalize()
        .map_err(|_| "PathUnavailable".to_string())?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    if resolved != root && !resolved.starts_with(root) {
        return Err("PathOutsideWorkspace".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
pub fn agent_scope_register(
    state: tauri::State<'_, WorkspaceScopeRegistry>,
    run_id: String,
    workspace_id: String,
    workspace_root: String,
) -> Result<String, String> {
    state.register(&run_id, &workspace_id, Path::new(&workspace_root))
}

#[tauri::command]
pub fn agent_scope_reregister(
    state: tauri::State<'_, WorkspaceScopeRegistry>,
    run_id: String,
    workspace_id: String,
    workspace_root: String,
) -> Result<String, String> {
    state.reregister(&run_id, &workspace_id, Path::new(&workspace_root))
}

#[tauri::command]
pub fn agent_scope_revoke(
    state: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
) -> Result<bool, String> {
    state.revoke(&scope_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, WorkspaceScopeRegistry, String) {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("nested")).unwrap();
        fs::write(directory.path().join("nested/file.txt"), "inside").unwrap();
        let registry = WorkspaceScopeRegistry::new();
        let scope = registry
            .register("run-1", "workspace-1", directory.path())
            .unwrap();
        (directory, registry, scope)
    }

    #[test]
    fn rejects_absolute_parent_and_non_normalized_paths() {
        let (_directory, registry, scope) = workspace();
        for escape in [
            "/etc/passwd",
            "C:/Windows/System32",
            "../outside",
            "nested/../../outside",
            "nested\\file.txt",
            "nested/./file.txt",
        ] {
            assert!(
                registry.resolve(&scope, escape).is_err(),
                "escape should fail: {escape}"
            );
        }
        for pattern in ["/tmp/*.txt", "../*.txt", "nested/../../*.txt"] {
            assert!(
                registry.scoped_glob_pattern(&scope, "", pattern).is_err(),
                "glob escape should fail: {pattern}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_search_result_outside_root() {
        let (directory, registry, scope) = workspace();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("escape")).unwrap();

        assert_eq!(
            registry.resolve(&scope, "escape/secret.txt"),
            Err("PathOutsideWorkspace".to_string())
        );
        assert_eq!(
            registry.relative_search_result(&scope, &outside.path().join("secret.txt")),
            Err("SearchResultOutsideWorkspace".to_string())
        );
    }

    #[test]
    fn restart_reregistration_issues_a_new_opaque_scope() {
        let directory = tempfile::tempdir().unwrap();
        let before_restart_registry = WorkspaceScopeRegistry::new();
        let before_restart = before_restart_registry
            .register("run-1", "workspace-1", directory.path())
            .unwrap();
        let replacement = before_restart_registry
            .reregister("run-1", "workspace-1", directory.path())
            .unwrap();
        assert_ne!(before_restart, replacement);
        assert_eq!(
            before_restart_registry.resolve(&before_restart, ""),
            Err("WorkspaceScopeUnavailable".to_string())
        );

        let after_restart_registry = WorkspaceScopeRegistry::new();
        let after_restart = after_restart_registry
            .reregister("run-1", "workspace-1", directory.path())
            .unwrap();

        assert_ne!(before_restart, after_restart);
        assert_eq!(after_restart.len(), 64);
        assert!(!after_restart.contains("run-1"));
        assert!(!after_restart.contains("workspace-1"));
    }

    #[test]
    fn revoked_scope_cannot_resolve_paths() {
        let (_directory, registry, scope) = workspace();
        assert!(registry.revoke(&scope).unwrap());
        assert_eq!(
            registry.resolve(&scope, "nested/file.txt"),
            Err("WorkspaceScopeUnavailable".to_string())
        );
    }

    #[test]
    fn scoped_glob_escapes_metacharacters_in_the_base() {
        let escaped = escape_glob_metacharacters("/tmp/work[space]");
        assert_eq!(escaped, "/tmp/work[[]space[]]");
    }

    #[test]
    fn unavailable_root_cannot_be_registered() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert_eq!(
            WorkspaceScopeRegistry::new().register("run-1", "workspace-1", &missing),
            Err("WorkspaceRootUnavailable".to_string())
        );
    }
}
