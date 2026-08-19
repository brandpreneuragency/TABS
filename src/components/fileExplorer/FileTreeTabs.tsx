import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores/workspaceStore';

/**
 * Workspace folder control for the file tree.
 *
 * Each workspace tab has at most one attached folder (the AI agent root).
 * Empty: full-width "CONNECT FOLDER" opens the native/browser picker.
 * Selected: shows the folder path; click is a no-op (no replace/clear).
 */
export function FileTreeTabs() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loading = useWorkspaceStore((s) => s.loading);
  const connectFolderInWorkspace = useWorkspaceStore((s) => s.connectFolderInWorkspace);
  const getActiveConnectedFolders = useWorkspaceStore((s) => s.getActiveConnectedFolders);
  const getActiveFolderId = useWorkspaceStore((s) => s.getActiveFolderId);

  const connectedFolders = getActiveConnectedFolders();
  const activeFolderId = getActiveFolderId();
  const activeFolder =
    connectedFolders.find((f) => f.id === activeFolderId) ?? connectedFolders[0] ?? null;
  // Prefer absolute path so the user sees the full route, not only the basename.
  const folderPath = activeFolder?.path ?? activeFolder?.rootNode?.fullPath ?? null;
  const hasFolder = Boolean(folderPath);
  const canSelect = Boolean(activeWorkspaceId) && !hasFolder && !loading;

  const label = hasFolder
    ? folderPath!
    : loading
      ? t('explorer.opening')
      : t('explorer.selectFolder');

  const ariaLabel = hasFolder
    ? t('explorer.workspaceFolderAria', { name: folderPath })
    : t('explorer.selectFolder');

  const handleNativeClick = () => {
    if (!canSelect || !activeWorkspaceId) return;
    void connectFolderInWorkspace(activeWorkspaceId);
  };

  return (
    <div
      id="filetree-root-row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '32px',
        alignItems: 'stretch',
        gap: 0,
        marginBottom: '0px',
        marginLeft: '0px',
        marginRight: '0px',
        padding: '0px',
        borderRadius: '8px 8px 0 0',
        backgroundColor: 'transparent',
        borderTop: 'none',
        borderRight: 'none',
        borderLeft: 'none',
        borderBottom: 'none',
      }}
    >
      <button
        type="button"
        className={`filetree-select-folder-btn${hasFolder ? ' is-selected' : ''}`}
        onClick={handleNativeClick}
        disabled={!canSelect}
        aria-disabled={!canSelect}
        aria-label={ariaLabel}
        title={hasFolder ? folderPath! : t('explorer.selectFolder')}
      >
        <span className="filetree-select-folder-label">{label}</span>
      </button>
    </div>
  );
}
