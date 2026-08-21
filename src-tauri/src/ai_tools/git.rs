use std::path::PathBuf;
use std::process::Command;

use crate::agent_tools::scope::WorkspaceScopeRegistry;
use crate::ai_tools::shell::bounded_environment;

pub const GIT_MAX_OUTPUT_BYTES: usize = 65_536;

#[derive(serde::Serialize)]
pub struct GitResult {
    pub output: String,
    pub truncated: bool,
}

fn truncate_output(mut text: String) -> GitResult {
    let truncated = text.len() > GIT_MAX_OUTPUT_BYTES;
    if truncated {
        text.truncate(GIT_MAX_OUTPUT_BYTES);
    }
    GitResult {
        output: text,
        truncated,
    }
}

/// Direct git invocation so status/diff never go through a shell wrapper.
pub fn git_direct(root: PathBuf, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env_clear()
        .envs(bounded_environment())
        .output()
        .map_err(|e| format!("git failed: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&output.stderr).to_string();
    }
    Ok(text)
}

fn run_git(
    scopes: &WorkspaceScopeRegistry,
    scope_id: &str,
    args: &[&str],
    path: Option<&str>,
) -> Result<GitResult, String> {
    let root = scopes.root(scope_id)?;
    if let Some(relative) = path {
        let _ = scopes.resolve(scope_id, relative)?;
    }
    let mut argv: Vec<&str> = args.to_vec();
    if let Some(relative) = path {
        argv.push("--");
        argv.push(relative);
    }
    let output = git_direct(root, &argv)?;
    Ok(truncate_output(output))
}

#[tauri::command]
pub fn ai_git_status(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: Option<String>,
    _cancel_id: Option<String>,
) -> Result<GitResult, String> {
    run_git(
        &scopes,
        &scope_id,
        &["status", "--porcelain=v1", "-u"],
        path.as_deref(),
    )
}

#[tauri::command]
pub fn ai_git_diff(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: Option<String>,
    _cancel_id: Option<String>,
) -> Result<GitResult, String> {
    run_git(&scopes, &scope_id, &["diff", "--no-color"], path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::scope::WorkspaceScopeRegistry;
    use std::fs;
    use std::process::Command;

    #[test]
    fn git_status_and_diff_are_read_only() {
        let directory = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(directory.path())
            .output()
            .unwrap();
        fs::write(directory.path().join("file.txt"), "one\n").unwrap();
        Command::new("git")
            .args(["add", "file.txt"])
            .current_dir(directory.path())
            .output()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=tabs@example.com",
                "-c",
                "user.name=TABS",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(directory.path())
            .output()
            .unwrap();
        fs::write(directory.path().join("file.txt"), "two\n").unwrap();

        let status = git_direct(
            directory.path().to_path_buf(),
            &["status", "--porcelain=v1", "-u"],
        )
        .unwrap();
        assert!(status.contains("file.txt"), "{status}");
        let diff = git_direct(directory.path().to_path_buf(), &["diff", "--no-color"]).unwrap();
        assert!(diff.contains("-one") || diff.contains("+two") || !diff.is_empty());

        let registry = WorkspaceScopeRegistry::new();
        let scope = registry
            .register("run-1", "workspace-1", directory.path())
            .unwrap();
        assert!(registry.resolve(&scope, "file.txt").is_ok());
        assert!(registry.resolve(&scope, "../outside").is_err());
    }
}
