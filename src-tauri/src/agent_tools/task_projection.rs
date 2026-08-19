use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

fn relative_projection_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    let has_drive_prefix = value.as_bytes().get(1) == Some(&b':');
    let segments: Vec<&str> = value.split(['/', '\\']).collect();
    if value.is_empty()
        || value.starts_with(['/', '\\'])
        || has_drive_prefix
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("projection path must be relative, normalized, and contained by TASKS".into());
    }
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("projection path must be relative, normalized, and contained by TASKS".into());
    }
    Ok(path)
}

fn remove_stale(root: &Path, relative: &str) -> Result<(), String> {
    let path = root.join(relative_projection_path(relative)?);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove stale projection: {error}")),
    }
}

fn apply_projection(
    root: &Path,
    target_path: &str,
    serialized_content: Option<&str>,
    stale_paths: &[String],
) -> Result<(), String> {
    let target = root.join(relative_projection_path(target_path)?);
    fs::create_dir_all(root).map_err(|error| format!("failed to create TASKS root: {error}"))?;

    if let Some(content) = serialized_content {
        let parent = target
            .parent()
            .ok_or_else(|| "projection target has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create projection directory: {error}"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("failed to create projection temporary file: {error}"))?;
        temporary
            .write_all(content.as_bytes())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|error| format!("failed to write projection temporary file: {error}"))?;
        temporary.persist(&target).map_err(|error| {
            format!(
                "failed to rename projection temporary file: {}",
                error.error
            )
        })?;
    } else {
        remove_stale(root, target_path)?;
    }

    // Stale paths are deliberately removed only after the replacement is durable.
    for stale in stale_paths {
        if stale != target_path {
            remove_stale(root, stale)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn task_projection_apply(
    app: AppHandle,
    target_path: String,
    serialized_content: Option<String>,
    stale_paths: Vec<String>,
) -> Result<(), String> {
    // This fixed root is resolved natively; no frontend-provided root is accepted.
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve app-local data directory: {error}"))?
        .join("TASKS");
    apply_projection(
        &root,
        &target_path,
        serialized_content.as_deref(),
        &stale_paths,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_traversal_and_non_normalized_paths() {
        assert!(relative_projection_path("../outside.md").is_err());
        assert!(relative_projection_path("/absolute.md").is_err());
        assert!(relative_projection_path("project/./task.md").is_err());
        assert!(relative_projection_path("project/task.md").is_ok());
    }

    #[test]
    fn writes_then_removes_stale_projection_paths() {
        let root = tempfile::tempdir().unwrap();
        let stale = root.path().join("old/task.md");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "old").unwrap();

        apply_projection(
            root.path(),
            "new/task.md",
            Some("exact content\n"),
            &["old/task.md".to_string()],
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("new/task.md")).unwrap(),
            "exact content\n"
        );
        assert!(!stale.exists());
    }

    #[test]
    fn failed_write_keeps_stale_path() {
        let root = tempfile::tempdir().unwrap();
        let stale = root.path().join("old/task.md");
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "old").unwrap();
        fs::create_dir_all(root.path().join("new/task.md")).unwrap();

        assert!(apply_projection(
            root.path(),
            "new/task.md",
            Some("content"),
            &["old/task.md".to_string()],
        )
        .is_err());
        assert!(stale.exists());
    }
}
