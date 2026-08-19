use std::sync::mpsc;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;

use crate::agent_tools::scope::WorkspaceScopeRegistry;

#[derive(serde::Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[tauri::command]
pub fn ai_glob(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    pattern: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let base_path = path.as_deref().unwrap_or("");
    let full_pattern = scopes.scoped_glob_pattern(&scope_id, base_path, &pattern)?;

    let mut output = Vec::new();
    for entry in glob::glob(&full_pattern).map_err(|e| format!("bad glob: {e}"))? {
        match entry {
            Ok(path) => output.push(scopes.relative_search_result(&scope_id, &path)?),
            Err(error) => return Err(format!("glob error: {error}")),
        }
    }
    output.sort();
    output.dedup();
    Ok(output)
}

#[tauri::command]
pub fn ai_grep(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    case_insensitive: Option<bool>,
) -> Result<Vec<GrepMatch>, String> {
    let base = scopes.resolve(&scope_id, path.as_deref().unwrap_or(""))?;
    let relative_base = scopes.relative_search_result(&scope_id, &base)?;

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(case_insensitive.unwrap_or(false))
        .build(&pattern)
        .map_err(|e| format!("bad regex: {e}"))?;

    let (sender, receiver) = mpsc::channel::<GrepMatch>();
    let glob_filter = glob.clone();
    let mut searcher = Searcher::new();
    searcher
        .search_path(
            &matcher,
            &base,
            UTF8(|line_number, line| {
                if let Some(filter) = &glob_filter {
                    if !glob::Pattern::new(filter)
                        .map(|pattern| pattern.matches(&relative_base))
                        .unwrap_or(false)
                    {
                        return Ok(true);
                    }
                }
                let _ = sender.send(GrepMatch {
                    path: relative_base.clone(),
                    line: line_number as usize,
                    text: line.trim_end_matches(['\n', '\r']).to_string(),
                });
                Ok(true)
            }),
        )
        .map_err(|e| format!("grep failed: {e}"))?;

    let mut matches: Vec<GrepMatch> = receiver.iter().collect();
    matches.sort_by(|left, right| left.path.cmp(&right.path).then(left.line.cmp(&right.line)));
    Ok(matches)
}
