use std::path::Path;
use std::sync::mpsc;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;

use crate::ai_tools::sandbox::resolve_in_workspace;

#[derive(serde::Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// Glob `pattern` (e.g. `**/*.rs`) relative to the workspace root (or `path` if
/// given). Returns workspace-relative paths.
#[tauri::command]
pub fn ai_glob(
    workspace_root: String,
    pattern: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let root = Path::new(&workspace_root);
    let base = match path {
        Some(p) => resolve_in_workspace(root, &p)?,
        None => root.to_path_buf(),
    };
    let full_pattern = base.join(&pattern).to_string_lossy().replace('\\', "/");

    let mut out: Vec<String> = Vec::new();
    for entry in glob::glob(&full_pattern).map_err(|e| format!("bad glob: {e}"))? {
        match entry {
            Ok(p) => out.push(relative_to(root, &p)),
            Err(e) => return Err(format!("glob error: {e}")),
        }
    }
    out.sort();
    Ok(out)
}

/// Grep `pattern` across the workspace (or `path` if given), optionally restricted
/// by `glob` and case sensitivity. Returns matches with line numbers + text.
#[tauri::command]
pub fn ai_grep(
    workspace_root: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    case_insensitive: Option<bool>,
) -> Result<Vec<GrepMatch>, String> {
    let root = Path::new(&workspace_root);
    let base = match path {
        Some(p) => resolve_in_workspace(root, &p)?,
        None => root.to_path_buf(),
    };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let (tx, rx) = mpsc::channel::<GrepMatch>();
    let root_for_thread = root.to_path_buf();
    let glob_for_thread = glob.clone();

    let mut searcher = Searcher::new();
    searcher
        .search_path(
            &matcher,
            &base,
            UTF8(|lnum, line| {
                // Honour the optional glob filter on the matched file path.
                if let Some(g) = &glob_for_thread {
                    let rel = relative_to(&root_for_thread, &base);
                    if !glob::Pattern::new(g)
                        .map(|p| p.matches(&rel))
                        .unwrap_or(true)
                    {
                        return Ok(true);
                    }
                }
                let _ = tx.send(GrepMatch {
                    path: relative_to(&root_for_thread, &base),
                    line: lnum as usize,
                    text: line.trim_end_matches(['\n', '\r']).to_string(),
                });
                Ok(true)
            }),
        )
        .map_err(|e| format!("grep failed: {e}"))?;

    // The sender (`tx`) is owned by the sink closure, which is consumed by
    // `search_path`, so it is dropped here — unblocking the receiver.
    let mut matches: Vec<GrepMatch> = rx.iter().collect();
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(matches)
}

/// Return `p` relative to `root` as a forward-slash string.
fn relative_to(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}
