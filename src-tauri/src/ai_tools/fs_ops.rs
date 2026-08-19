use std::fs;
use std::io::Write;

use crate::agent_tools::scope::WorkspaceScopeRegistry;

#[derive(serde::Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub line_count: usize,
}

#[derive(serde::Serialize)]
pub struct FileWriteResult {
    pub bytes_written: usize,
}

#[derive(serde::Serialize)]
pub struct FileEditResult {
    pub replacements: usize,
}

/// Read a file through a frozen native workspace scope. Optional 1-based
/// `offset` and `limit` slice the returned, numbered lines.
#[tauri::command]
pub fn ai_file_read(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileReadResult, String> {
    let full = scopes.resolve(&scope_id, &path)?;
    if !full.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let raw = fs::read_to_string(&full).map_err(|e| format!("read failed: {e}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let total = lines.len();
    let start = offset.unwrap_or(1).saturating_sub(1).min(total);
    let end = match limit {
        Some(value) => start.saturating_add(value).min(total),
        None => total,
    };
    let sliced: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{}", start + index + 1, line))
        .collect();
    Ok(FileReadResult {
        content: sliced.join("\n"),
        line_count: total,
    })
}

/// Atomically write beneath a frozen native workspace scope.
#[tauri::command]
pub fn ai_file_write(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: String,
    content: String,
) -> Result<FileWriteResult, String> {
    let root = scopes.root(&scope_id)?;
    let full = scopes.resolve(&scope_id, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let directory = full.parent().map(|path| path.to_path_buf()).unwrap_or(root);
    let mut temporary = tempfile::Builder::new()
        .prefix(".tabs-write-")
        .tempfile_in(&directory)
        .map_err(|e| format!("tempfile failed: {e}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|e| format!("temp write failed: {e}"))?;
    temporary
        .persist(&full)
        .map_err(|e| format!("rename failed: {e}"))?;
    Ok(FileWriteResult {
        bytes_written: content.len(),
    })
}

/// Replace checked text beneath a frozen native workspace scope.
#[tauri::command]
pub fn ai_file_edit(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: String,
    old: String,
    new: String,
    replace_all: Option<bool>,
) -> Result<FileEditResult, String> {
    let full = scopes.resolve(&scope_id, &path)?;
    if !full.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let raw = fs::read_to_string(&full).map_err(|e| format!("read failed: {e}"))?;
    let count = raw.matches(&old).count();
    if count == 0 {
        return Err("old string not found in file".to_string());
    }
    let replace_all = replace_all.unwrap_or(false);
    if !replace_all && count > 1 {
        return Err(format!(
            "old string is not unique ({count} occurrences); set replace_all or provide more context"
        ));
    }
    let updated = if replace_all {
        raw.replace(&old, &new)
    } else {
        raw.replacen(&old, &new, 1)
    };
    fs::write(&full, updated).map_err(|e| format!("write failed: {e}"))?;
    Ok(FileEditResult {
        replacements: if replace_all { count } else { 1 },
    })
}
