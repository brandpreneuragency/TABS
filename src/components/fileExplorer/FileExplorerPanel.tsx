import { useState, useRef, useEffect, useCallback } from 'react';
import type React from 'react';
import {
  FilePlus, FolderPlus, X,
  File, Folder,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore, type TreeNode as TreeNodeType } from '../../stores/workspaceStore';
import { useUIStore } from '../../stores/uiStore';
import { TreeNode } from './TreeNode';
import { FileTreeTabs } from './FileTreeTabs';
import { AgentLaunchButton } from '../agent/AgentLaunchButton';

const POLL_INTERVAL_MS = 10_000;
const SEARCH_RESULT_LIMIT = 50;

function hasUnloadedDirectory(node: TreeNodeType): boolean {
  if (node.kind !== 'directory') return false;
  if (node.children === undefined) return true;
  return node.children.some(hasUnloadedDirectory);
}

function collectSearchMatches(nodes: TreeNodeType[], query: string, max = SEARCH_RESULT_LIMIT): TreeNodeType[] {
  const results: TreeNodeType[] = [];
  const walk = (node: TreeNodeType) => {
    if (results.length >= max) return;
    if (node.name.toLowerCase().includes(query)) {
      results.push(node);
    }
    node.children?.forEach(walk);
  };
  for (const node of nodes) {
    walk(node);
    if (results.length >= max) break;
  }
  return results;
}

export function FileExplorerPanel() {
  const { t } = useTranslation();
  const {
    workspaces,
    activeWorkspaceId,
    refreshWorkspaceDir,
    createFileInWorkspace,
    createDirectoryInWorkspace,
    ensureSubtreeLoaded,
    ensureChildrenLoaded,
    swapFileInWorkspace,
    setExpandedPaths,
    setSelectedTreePath,
    error,
    getActiveRootNode,
    getActiveFolderId,
  } = useWorkspaceStore();
  const fileExplorerOpen = useUIStore((s) => s.contextPanelOpenByMode.documents);

  // Derive active workspace state
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const rootNode = getActiveRootNode();
  const activeFolderId = getActiveFolderId();
  const expandedPaths = activeWs?.expandedPaths ?? [];

  // inline input at root level (new file / new folder)
  const [rootInput, setRootInput] = useState<{ mode: 'new-file' | 'new-folder' } | null>(null);
  const [rootInputValue, setRootInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const rootInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const searchActive = normalizedSearch.length > 0;
  const searchIndexing = searchActive && Boolean(rootNode && hasUnloadedDirectory(rootNode));
  const searchMatches = rootNode?.children && searchActive
    ? collectSearchMatches(rootNode.children, normalizedSearch)
    : [];

  useEffect(() => {
    if (rootInput && rootInputRef.current) {
      rootInputRef.current.focus();
    }
  }, [rootInput]);

  // Track the folder ID that was active when the search query was entered.
  // This lets us distinguish "user is typing in search" from "rootNode changed
  // because the user switched root folders" so we don't trigger a full subtree
  // load on every folder switch.
  const searchFolderIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (searchActive) {
      searchFolderIdRef.current = activeFolderId;
    }
  }, [searchActive, activeFolderId]);

  // Clear search when switching root folders – the old query is meaningless
  // in the new folder and would otherwise trigger ensureSubtreeLoaded on the
  // entire new tree (potentially thousands of readDir calls).
  useEffect(() => {
    if (searchActive && searchFolderIdRef.current !== activeFolderId) {
      setSearchQuery('');
      setSearchDropdownOpen(false);
      searchFolderIdRef.current = activeFolderId;
    }
  }, [activeFolderId, searchActive]);

  useEffect(() => {
    if (!searchActive || !searchIndexing || !rootNode || !activeWorkspaceId) return;
    // Only trigger the expensive full-subtree load when the search query
    // actually changed (not when rootNode changed due to a folder switch).
    if (searchFolderIdRef.current !== activeFolderId) return;
    void ensureSubtreeLoaded(activeWorkspaceId, rootNode.fullPath).catch(() => undefined);
  }, [ensureSubtreeLoaded, rootNode, searchActive, searchIndexing, activeFolderId, activeWorkspaceId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // --- Stable polling refs ---
  // The poll must NOT re-create the interval on every rootNode / expandedPaths
  // change.  Previously the effect listed both as dependencies, which meant:
  //   • refreshDir() updates rootNode → effect re-runs → interval reset
  //   • user expands/collapses a folder → expandedPaths changes → interval reset
  //   • switching root folders → rootNode changes → interval reset
  // Using refs keeps a single long-lived interval that always reads the latest
  // values without tearing down / recreating the timer.
  const rootPathRef = useRef<string | null>(null);
  const expandedPathsRef = useRef<string[]>(expandedPaths);

  useEffect(() => { rootPathRef.current = rootNode?.fullPath ?? null; }, [rootNode]);
  useEffect(() => { expandedPathsRef.current = expandedPaths; }, [expandedPaths]);

  const stablePoll = useCallback(async () => {
    const rootPath = rootPathRef.current;
    if (!rootPath || !activeWorkspaceId) return;
    await refreshWorkspaceDir(activeWorkspaceId, rootPath);
    const paths = expandedPathsRef.current;
    if (paths.length > 0) {
      await Promise.all(paths.map((p) => refreshWorkspaceDir(activeWorkspaceId, p)));
    }
  }, [refreshWorkspaceDir, activeWorkspaceId]);

  // Poll-based external-change detection while panel is visible
  useEffect(() => {
    if (!fileExplorerOpen || !rootNode) return;
    const id = setInterval(stablePoll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fileExplorerOpen, rootNode, stablePoll]);

  const startRootNew = (mode: 'new-file' | 'new-folder') => {
    if (!rootNode || !activeWorkspaceId) return;
    // ensure root is "expanded" so the virtual row appears
    if (!expandedPaths.includes(rootNode.path)) {
      setExpandedPaths(activeWorkspaceId, [...expandedPaths, rootNode.path]);
    }
    setRootInput({ mode });
    setRootInputValue('');
  };

  const commitRootInput = async () => {
    if (!rootInput || !rootNode || !activeWorkspaceId) return;
    const val = rootInputValue.trim();
    const mode = rootInput.mode;
    setRootInput(null);
    if (!val) return;
    if (mode === 'new-file') await createFileInWorkspace(activeWorkspaceId, rootNode.fullPath, val);
    else await createDirectoryInWorkspace(activeWorkspaceId, rootNode.fullPath, val);
  };

  const handleRootInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRootInput();
    else if (e.key === 'Escape') setRootInput(null);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchQuery('');
      setSearchDropdownOpen(false);
      e.currentTarget.blur();
    }
  };

  const handleSearchResultClick = async (node: TreeNodeType) => {
    if (!activeWorkspaceId) return;
    setSelectedTreePath(activeWorkspaceId, node.path);
    if (node.kind === 'directory') {
      if (node.children === undefined) {
        await ensureChildrenLoaded(activeWorkspaceId, node.fullPath);
      }
      if (!expandedPaths.includes(node.path)) {
        setExpandedPaths(activeWorkspaceId, [...expandedPaths, node.path]);
      }
    } else {
      await swapFileInWorkspace(activeWorkspaceId, node, { skipPrompt: true });
    }
    setSearchDropdownOpen(false);
    setSearchQuery('');
  };

  return (
    <div className="panel flex-col h-full" style={{ display: 'flex', minHeight: 0 }}>
      <div className="panel-header fep-header">
        <div className="shrink-0" style={{ height: 'fit-content', paddingLeft: 0, paddingRight: 0 }}>
          <FileTreeTabs />
        </div>
        <AgentLaunchButton source="documents" />

        {rootNode?.children && (
          <div
            id="filetree-search"
            ref={searchRef}
            role="search"
            className="filetree-search"
          >
            <div className="filetree-search-input-wrap">
              <input
                type="search"
                className="filetree-search-input"
                aria-label={t('explorer.searchFiles')}
                title={t('explorer.searchFiles')}
                placeholder={t('explorer.searchPlaceholder')}
                value={searchQuery}
                spellCheck={false}
                aria-expanded={searchDropdownOpen}
                aria-haspopup="listbox"
                onFocus={() => setSearchDropdownOpen(true)}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="filetree-search-clear"
                  title={t('explorer.clearSearch')}
                  aria-label={t('explorer.clearSearch')}
                  onClick={() => setSearchQuery('')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div
              className="flex items-center gap-0.5 filetree-actions"
              style={{ padding: 0, fontSize: 'var(--fs-xs)' }}
            >
              <button
                type="button"
                onClick={() => startRootNew('new-file')}
                title={t('explorer.newFile')}
                aria-label={t('explorer.newFile')}
                className="btn-icon"
              >
                <FilePlus size={14} />
              </button>
              <button
                type="button"
                onClick={() => startRootNew('new-folder')}
                title={t('explorer.newFolder')}
                aria-label={t('explorer.newFolder')}
                className="btn-icon"
              >
                <FolderPlus size={12} />
              </button>
            </div>
            {searchDropdownOpen && (
              <div
                className="drop"
                role="listbox"
                aria-label={t('explorer.searchFiles')}
                style={{ left: 0, top: '100%', marginTop: 0, marginRight: 0, minWidth: 0, width: 182 }}
              >
                {searchIndexing && (
                  <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>
                    {t('explorer.searchLoading')}
                  </div>
                )}
                {!searchIndexing && searchActive && searchMatches.map((node) => (
                  <button
                    type="button"
                    key={node.path}
                    role="option"
                    onClick={() => { void handleSearchResultClick(node); }}
                    className="drop-item"
                    style={{ fontSize: 'var(--fs-base)' }}
                  >
                    {node.kind === 'file'
                      ? <File size={11} style={{ flexShrink: 0, color: 'var(--c-text-2)' }} />
                      : <Folder size={11} style={{ flexShrink: 0, color: 'var(--c-text-2)' }} />}
                    <span className="trunc med">{node.name}</span>
                  </button>
                ))}
                {!searchIndexing && searchActive && searchMatches.length === 0 && (
                  <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>
                    {t('explorer.noSearchMatches')}
                  </div>
                )}
                {!searchActive && (
                  <div className="subtle" style={{ padding: '8px 12px', fontSize: 'var(--fs-base)' }}>
                    {t('explorer.searchPlaceholder')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="panel-body ai-scroll flex-1 overflow-y-a" style={{ minHeight: 0, padding: '8px 8px 8px 0' }}>
        {error && (
          <p style={{ fontSize: 'var(--fs-xs)', color: '#EF4444', marginBottom: 8, lineHeight: 1.375 }}>{error}</p>
        )}

        {rootNode?.children && (
          <ul id="filetree-list" style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            listStyle: 'none', padding: 0, margin: 0,
          }}>
            {rootNode.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={0} />
            ))}

            {/* Root-level inline new entry */}
            {rootInput && (
              <li
                className="tree-node row-xs"
                style={{
                  '--tree-depth': 0, height: 28, fontSize: 'var(--fs-xs)',
                  color: 'var(--c-text-1)',
                } as React.CSSProperties}
              >
                <span className="shrink-0" style={{ width: 14 }} />
                {rootInput.mode === 'new-file'
                  ? <File size={13} className="shrink-0 subtle" />
                  : <Folder size={13} className="shrink-0" style={{ color: 'var(--c-text-2)' }} />
                }
                <input
                  ref={rootInputRef}
                  title={rootInput.mode === 'new-file' ? t('explorer.newFileName') : t('explorer.newFolderName')}
                  placeholder={rootInput.mode === 'new-file' ? t('explorer.filenamePlaceholder') : t('explorer.folderPlaceholder')}
                  className="ctrl-xs flex-1 min-w-0"
                  style={{ marginLeft: 4, marginRight: 12, borderColor: 'var(--c-accent-center-panel)' }}
                  value={rootInputValue}
                  onChange={(e) => setRootInputValue(e.target.value)}
                  onKeyDown={handleRootInputKey}
                  onBlur={commitRootInput}
                />
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}