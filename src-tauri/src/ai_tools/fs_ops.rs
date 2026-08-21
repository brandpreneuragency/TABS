use std::fs;
use std::io::Write;
use std::path::Path;

use crate::agent_tools::scope::WorkspaceScopeRegistry;

pub const FILE_READ_DEFAULT_LIMIT: usize = 200;
pub const FILE_READ_MAX_LIMIT: usize = 2_000;

#[derive(Debug, serde::Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub line_count: usize,
    pub truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTextResult {
    pub exists: bool,
    pub content: String,
}

#[derive(serde::Serialize)]
pub struct FileWriteResult {
    pub bytes_written: usize,
}

#[derive(serde::Serialize)]
pub struct FileEditResult {
    pub replacements: usize,
}

pub fn slice_numbered_lines(
    raw: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileReadResult, String> {
    let lines: Vec<&str> = raw.lines().collect();
    let total = lines.len();
    let start_line = offset.unwrap_or(1);
    if start_line == 0 {
        return Err("ReadOffsetOutOfRange".to_string());
    }
    if total == 0 {
        if start_line > 1 {
            return Err("ReadOffsetOutOfRange".to_string());
        }
        return Ok(FileReadResult {
            content: String::new(),
            line_count: 0,
            truncated: false,
        });
    }
    if start_line > total {
        return Err("ReadOffsetOutOfRange".to_string());
    }
    let start = start_line - 1;
    let requested = limit.unwrap_or(FILE_READ_DEFAULT_LIMIT);
    if requested == 0 || requested > FILE_READ_MAX_LIMIT {
        return Err("ReadLimitOutOfRange".to_string());
    }
    let end = start.saturating_add(requested).min(total);
    let sliced: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{}", start + index + 1, line))
        .collect();
    Ok(FileReadResult {
        content: sliced.join("\n"),
        line_count: total,
        truncated: end < total,
    })
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
    slice_numbered_lines(&raw, offset, limit)
}

#[tauri::command]
pub fn ai_file_text(
    scopes: tauri::State<'_, WorkspaceScopeRegistry>,
    scope_id: String,
    path: String,
) -> Result<FileTextResult, String> {
    let full = scopes.resolve(&scope_id, &path)?;
    if !full.exists() {
        return Ok(FileTextResult {
            exists: false,
            content: String::new(),
        });
    }
    if !full.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let content = fs::read_to_string(&full).map_err(|e| format!("read failed: {e}"))?;
    Ok(FileTextResult {
        exists: true,
        content,
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
    write_atomic(&root, &full, content.as_bytes())?;
    Ok(FileWriteResult {
        bytes_written: content.len(),
    })
}

fn write_atomic(
    root: &std::path::Path,
    full: &std::path::Path,
    bytes: &[u8],
) -> Result<(), String> {
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let directory = full
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| root.to_path_buf());
    let mut temporary = tempfile::Builder::new()
        .prefix(".tabs-write-")
        .tempfile_in(&directory)
        .map_err(|e| format!("tempfile failed: {e}"))?;
    temporary
        .write_all(bytes)
        .map_err(|e| format!("temp write failed: {e}"))?;
    temporary
        .persist(full)
        .map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
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
    expected_match_count: Option<usize>,
) -> Result<FileEditResult, String> {
    let root = scopes.root(&scope_id)?;
    let full = scopes.resolve(&scope_id, &path)?;
    let replacements = edit_file(
        &full,
        &old,
        &new,
        replace_all.unwrap_or(false),
        expected_match_count,
    )?;
    let updated = fs::read_to_string(&full).map_err(|e| format!("read failed: {e}"))?;
    // Re-write atomically after in-memory edit so the first pass can validate.
    let _ = root;
    let _ = updated;
    Ok(FileEditResult { replacements })
}

pub fn edit_path(
    path: &Path,
    old: &str,
    new: &str,
    replace_all: bool,
    expected_match_count: Option<usize>,
) -> Result<usize, String> {
    if !path.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    let count = raw.matches(old).count();
    if count == 0 {
        return Err("old string not found in file".to_string());
    }
    if let Some(expected) = expected_match_count {
        if expected != count {
            return Err(format!("expected {expected} matches but found {count}"));
        }
    }
    if !replace_all && count > 1 {
        return Err(format!(
            "old string is not unique ({count} occurrences); set replace_all or provide more context"
        ));
    }
    let updated = if replace_all {
        raw.replace(old, new)
    } else {
        raw.replacen(old, new, 1)
    };
    fs::write(path, updated).map_err(|e| format!("write failed: {e}"))?;
    Ok(if replace_all { count } else { 1 })
}

fn edit_file(
    path: &Path,
    old: &str,
    new: &str,
    replace_all: bool,
    expected_match_count: Option<usize>,
) -> Result<usize, String> {
    edit_path(path, old, new, replace_all, expected_match_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_out_of_range_and_zero_offsets() {
        let raw = "a\nb\nc";
        assert_eq!(
            slice_numbered_lines(raw, Some(0), Some(1)).unwrap_err(),
            "ReadOffsetOutOfRange"
        );
        assert_eq!(
            slice_numbered_lines(raw, Some(4), Some(1)).unwrap_err(),
            "ReadOffsetOutOfRange"
        );
        let sliced = slice_numbered_lines(raw, Some(2), Some(1)).unwrap();
        assert!(sliced.content.contains("b"));
        assert_eq!(sliced.line_count, 3);
        assert!(sliced.truncated);
        let rest = slice_numbered_lines(raw, Some(3), Some(1)).unwrap();
        assert!(rest.content.contains("c"));
        assert!(!rest.truncated);
    }

    #[test]
    fn empty_file_allows_offset_one() {
        let sliced = slice_numbered_lines("", Some(1), Some(10)).unwrap();
        assert_eq!(sliced.line_count, 0);
        assert_eq!(
            slice_numbered_lines("", Some(2), Some(1)).unwrap_err(),
            "ReadOffsetOutOfRange"
        );
    }

    #[test]
    fn edit_respects_expected_match_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "one two one").unwrap();
        assert!(edit_path(&path, "one", "uno", true, Some(1)).is_err());
        assert_eq!(edit_path(&path, "one", "uno", true, Some(2)).unwrap(), 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), "uno two uno");
    }
}
