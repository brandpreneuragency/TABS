use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;

use crate::agent_tools::scope::WorkspaceScopeRegistry;
use crate::ai_tools::cancel::ToolCancelRegistry;

pub const SEARCH_MATCH_LIMIT: usize = 200;

#[derive(serde::Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(serde::Serialize)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
    pub cancelled: bool,
}

fn glob_matches(filter: &str, relative: &str) -> bool {
    match glob::Pattern::new(filter) {
        Ok(pattern) => {
            pattern.matches(relative)
                || relative
                    .rsplit('/')
                    .next()
                    .map(|name| pattern.matches(name))
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

pub fn walk_files(root: &Path, base: &Path, cancel: &AtomicBool) -> Result<Vec<PathBuf>, String> {
    if ToolCancelRegistry::is_cancelled(cancel) {
        return Ok(Vec::new());
    }
    if base.is_file() {
        return Ok(vec![base.to_path_buf()]);
    }
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if ToolCancelRegistry::is_cancelled(cancel) {
            break;
        }
        let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir failed: {e}"))?;
        for entry in entries {
            if ToolCancelRegistry::is_cancelled(cancel) {
                break;
            }
            let entry = entry.map_err(|e| format!("dir entry failed: {e}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| format!("file type failed: {e}"))?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let canonical = match path.canonicalize() {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if canonical != root && !canonical.starts_with(root) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                files.push(path);
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn ai_glob(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    cancel: tauri::State<'_, ToolCancelRegistry>,
    scope_id: String,
    pattern: String,
    path: Option<String>,
    cancel_id: Option<String>,
    max_results: Option<usize>,
) -> Result<GlobResult, String> {
    let limit = max_results
        .unwrap_or(SEARCH_MATCH_LIMIT)
        .min(SEARCH_MATCH_LIMIT);
    let flag = cancel.flag(cancel_id.as_deref().unwrap_or("glob"));
    let base_path = path.as_deref().unwrap_or("");
    let full_pattern = scopes.scoped_glob_pattern(&scope_id, base_path, &pattern)?;

    let mut output = Vec::new();
    let mut truncated = false;
    let mut cancelled = false;
    for entry in glob::glob(&full_pattern).map_err(|e| format!("bad glob: {e}"))? {
        if ToolCancelRegistry::is_cancelled(&flag) {
            cancelled = true;
            break;
        }
        match entry {
            Ok(path) => {
                let relative = scopes.relative_search_result(&scope_id, &path)?;
                if output.len() >= limit {
                    truncated = true;
                    break;
                }
                output.push(relative);
            }
            Err(error) => return Err(format!("glob error: {error}")),
        }
    }
    output.sort();
    output.dedup();
    cancel.finish(cancel_id.as_deref().unwrap_or("glob"));
    Ok(GlobResult {
        paths: output,
        truncated,
        cancelled,
    })
}

#[tauri::command]
pub fn ai_grep(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    cancel: tauri::State<'_, ToolCancelRegistry>,
    scope_id: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    case_insensitive: Option<bool>,
    cancel_id: Option<String>,
    max_results: Option<usize>,
) -> Result<GrepResult, String> {
    let limit = max_results
        .unwrap_or(SEARCH_MATCH_LIMIT)
        .min(SEARCH_MATCH_LIMIT);
    let flag = cancel.flag(cancel_id.as_deref().unwrap_or("grep"));
    let root = scopes.root(&scope_id)?;
    let base = scopes.resolve(&scope_id, path.as_deref().unwrap_or(""))?;
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let files = walk_files(&root, &base, &flag)?;
    let (sender, receiver) = mpsc::channel::<GrepMatch>();
    let mut truncated = false;
    let mut cancelled = ToolCancelRegistry::is_cancelled(&flag);
    for file in files {
        if ToolCancelRegistry::is_cancelled(&flag) {
            cancelled = true;
            break;
        }
        let relative = match scopes.relative_search_result(&scope_id, &file) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(filter) = &glob {
            if !glob_matches(filter, &relative) {
                continue;
            }
        }
        let mut searcher = Searcher::new();
        let send = sender.clone();
        let relative_for_sink = relative.clone();
        let reached_limit = std::sync::atomic::AtomicBool::new(false);
        searcher
            .search_path(
                &matcher,
                &file,
                UTF8(|line_number, line| {
                    if ToolCancelRegistry::is_cancelled(&flag) {
                        return Ok(false);
                    }
                    if send
                        .send(GrepMatch {
                            path: relative_for_sink.clone(),
                            line: line_number as usize,
                            text: line.trim_end_matches(['\n', '\r']).to_string(),
                        })
                        .is_err()
                    {
                        reached_limit.store(true, std::sync::atomic::Ordering::SeqCst);
                        return Ok(false);
                    }
                    Ok(true)
                }),
            )
            .map_err(|e| format!("grep failed: {e}"))?;
        let _ = reached_limit;
    }
    drop(sender);
    let mut matches: Vec<GrepMatch> = Vec::new();
    for item in receiver {
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        matches.push(item);
    }
    matches.sort_by(|left, right| left.path.cmp(&right.path).then(left.line.cmp(&right.line)));
    if ToolCancelRegistry::is_cancelled(&flag) {
        cancelled = true;
    }
    cancel.finish(cancel_id.as_deref().unwrap_or("grep"));
    Ok(GrepResult {
        matches,
        truncated,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::scope::WorkspaceScopeRegistry;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn workspace() -> (tempfile::TempDir, WorkspaceScopeRegistry, String) {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("nested")).unwrap();
        fs::write(directory.path().join("a.txt"), "alpha\n").unwrap();
        fs::write(directory.path().join("nested/b.txt"), "beta\n").unwrap();
        let registry = WorkspaceScopeRegistry::new();
        let scope = registry
            .register("run-1", "workspace-1", directory.path())
            .unwrap();
        (directory, registry, scope)
    }

    #[test]
    fn walk_recurses_and_honors_cancellation() {
        let (directory, _registry, _scope) = workspace();
        let live = AtomicBool::new(false);
        let files = walk_files(directory.path(), directory.path(), &live).unwrap();
        assert_eq!(files.len(), 2);
        let stop = AtomicBool::new(true);
        let cancelled = walk_files(directory.path(), directory.path(), &stop).unwrap();
        assert!(cancelled.len() <= 1);
    }

    #[test]
    fn glob_filter_matches_file_name_or_relative_path() {
        assert!(glob_matches("*.txt", "nested/b.txt"));
        assert!(glob_matches("nested/*.txt", "nested/b.txt"));
        assert!(!glob_matches("*.rs", "nested/b.txt"));
    }
}
