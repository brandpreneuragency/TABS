use std::fs;
use std::io::Write;
use std::path::Path;

use crate::ai_tools::sandbox::resolve_in_workspace;

#[derive(serde::Serialize)]
pub struct FileReadResult {
    /// Content with `cat -n`-style line numbering applied by the frontend; here
    /// we return the raw content and the line count for the caller to format.
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

/// Read a file inside the workspace. Optional 1-based `offset` and `limit` slice
/// the returned lines. `content` is returned as raw text; the frontend applies
/// `cat -n` line numbering.
#[tauri::command]
pub fn ai_file_read(
    workspace_root: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileReadResult, String> {
    let root = Path::new(&workspace_root);
    let full = resolve_in_workspace(root, &path)?;
    if !full.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let raw = fs::read_to_string(&full).map_err(|e| format!("read failed: {e}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let total = lines.len();
    let start = offset.unwrap_or(1).saturating_sub(1);
    let end = match limit {
        Some(l) => (start + l).min(total),
        None => total,
    };
    let sliced: Vec<String> = lines[start..end.min(total)]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect();
    Ok(FileReadResult {
        content: sliced.join("\n"),
        line_count: total,
    })
}

/// Write `content` to a file inside the workspace, creating parent directories.
/// Uses an atomic tempfile + rename so a crash mid-write doesn't corrupt the file.
#[tauri::command]
pub fn ai_file_write(
    workspace_root: String,
    path: String,
    content: String,
) -> Result<FileWriteResult, String> {
    let root = Path::new(&workspace_root);
    let full = resolve_in_workspace(root, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let dir = full
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| root.to_path_buf());
    let mut tmp = tempfile::Builder::new()
        .prefix(".tabs-write-")
        .tempfile_in(&dir)
        .map_err(|e| format!("tempfile failed: {e}"))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("temp write failed: {e}"))?;
    tmp.persist(&full)
        .map_err(|e| format!("rename failed: {e}"))?;
    Ok(FileWriteResult {
        bytes_written: content.as_bytes().len(),
    })
}

/// Replace `old` with `new` in a workspace file. If `replace_all` is false and
/// `old` occurs more than once, returns an error so the model must disambiguate.
#[tauri::command]
pub fn ai_file_edit(
    workspace_root: String,
    path: String,
    old: String,
    new: String,
    replace_all: Option<bool>,
) -> Result<FileEditResult, String> {
    let root = Path::new(&workspace_root);
    let full = resolve_in_workspace(root, &path)?;
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
        replacements: count,
    })
}
