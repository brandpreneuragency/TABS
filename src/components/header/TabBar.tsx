import { useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useUIStore } from '../../stores/uiStore';
import { WorkspaceTab } from './WorkspaceTab';
import { CRM_HEADER_TABS, SETTINGS_HEADER_TABS, TASK_HEADER_TABS } from './moduleNav';
import type { CRMHeaderTab } from './moduleNav';
import type { LucideIcon } from 'lucide-react';

type DropSide = 'before' | 'after';

function ModuleHeaderTab({
  tabKey,
  label,
  icon: Icon,
  isActive,
  onClick,
}: {
  tabKey: string;
  label: string;
  icon: LucideIcon;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <div
      id={`tab-module-${isActive ? 'active' : 'passive'}-${tabKey}`}
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={`group relative justify-start min-w-0 pl-3 pr-3 ${isActive ? 'tab-active' : 'tab-passive'}`}
      title={label}
    >
      <Icon size={12} className="mr-1 flex-shrink-0" />
      <span className="txt-xs med trunc">{label}</span>
    </div>
  );
}

function reorderIds(
  ids: string[],
  fromId: string,
  toId: string,
  side: DropSide
): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1 || fromId === toId) return ids;
  const next = [...ids];
  next.splice(from, 1);
  let insertAt = next.indexOf(toId);
  if (insertAt === -1) return ids;
  if (side === 'after') insertAt += 1;
  next.splice(insertAt, 0, fromId);
  return next;
}

export function TabBar() {
  const { t } = useTranslation();
  const {
    taskMode,
    activeView,
    activeSettingsSubTab,
    setActiveSettingsSubTab,
    crmMode,
    activeCRMPage,
    setActiveCRMPage,
    activeFormsPage,
    setActiveFormsPage,
    activeTaskPage,
    setActiveTaskPage,
  } = useUIStore();
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    deleteWorkspace,
    renameWorkspace,
    createWorkspace,
    reorderWorkspaces,
  } = useWorkspaceStore();

  const tabsRowRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  // Drag-to-reorder state (workspace tabs only)
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverSide, setDragOverSide] = useState<DropSide>('before');
  // Suppress the click that follows a completed drag so we don't re-select.
  const didDragRef = useRef(false);
  // FLIP: previous left positions keyed by workspace id
  const prevLeftsRef = useRef<Map<string, number>>(new Map());
  const skipFlipRef = useRef(true);

  // Detect overflow to switch last tab to ellipsis mode
  useLayoutEffect(() => {
    const checkOverflow = () => {
      const el = tabsRowRef.current;
      if (!el) return;
      setIsOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    checkOverflow();
    const ro = new ResizeObserver(checkOverflow);
    if (tabsRowRef.current) ro.observe(tabsRowRef.current);
    window.addEventListener('resize', checkOverflow);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', checkOverflow);
    };
  }, [workspaces, taskMode, crmMode, activeCRMPage, activeFormsPage, activeTaskPage, activeView, activeSettingsSubTab]);

  // Subtle FLIP slide when workspace tab order changes
  useLayoutEffect(() => {
    const row = tabsRowRef.current;
    if (!row || taskMode || crmMode || activeView === 'settings') {
      prevLeftsRef.current = new Map();
      return;
    }

    const nodes = row.querySelectorAll<HTMLElement>('[data-ws-tab-id]');
    const nextLefts = new Map<string, number>();

    nodes.forEach((node) => {
      const id = node.dataset.wsTabId;
      if (!id) return;
      const left = node.getBoundingClientRect().left;
      nextLefts.set(id, left);

      if (skipFlipRef.current) return;
      const prev = prevLeftsRef.current.get(id);
      if (prev === undefined) return;
      const dx = prev - left;
      if (Math.abs(dx) < 0.5) return;

      node.style.transition = 'none';
      node.style.transform = `translateX(${dx}px)`;
      // Force reflow so the browser commits the pre-flip transform.
      void node.offsetWidth;
      node.style.transition = 'transform 0.18s ease';
      node.style.transform = '';
      const clear = () => {
        node.style.transition = '';
        node.style.transform = '';
        node.removeEventListener('transitionend', clear);
      };
      node.addEventListener('transitionend', clear);
    });

    prevLeftsRef.current = nextLefts;
    skipFlipRef.current = false;
  }, [workspaces, taskMode, crmMode, activeView]);

  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    didDragRef.current = false;
    setDragId(id);
    setDragOverId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragId || dragId === id) {
      if (dragOverId !== null) setDragOverId(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: DropSide = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (dragOverId !== id) setDragOverId(id);
    if (dragOverSide !== side) setDragOverSide(side);
  }, [dragId, dragOverId, dragOverSide]);

  const handleDrop = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault();
    const fromId = dragId ?? e.dataTransfer.getData('text/plain');
    const side = dragOverSide;
    setDragId(null);
    setDragOverId(null);
    setDragOverSide('before');
    if (!fromId || fromId === id) return;

    const ids = workspaces.map((w) => w.id);
    const next = reorderIds(ids, fromId, id, side);
    if (next.every((v, i) => v === ids[i])) return;

    didDragRef.current = true;
    reorderWorkspaces(next);
  }, [dragId, dragOverSide, workspaces, reorderWorkspaces]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
    setDragOverSide('before');
    // Clear the drag-click suppress on the next tick so the synthetic click is ignored.
    window.setTimeout(() => {
      didDragRef.current = false;
    }, 0);
  }, []);

  const handleSelect = useCallback((id: string) => {
    if (didDragRef.current) return;
    setActiveWorkspace(id);
  }, [setActiveWorkspace]);

  if (!taskMode && !crmMode && activeView === 'settings') {
    return (
      <div ref={tabsRowRef} className="tabs-row" data-overflowing={isOverflowing ? 'true' : 'false'}>
        {SETTINGS_HEADER_TABS.map((item) => (
          <ModuleHeaderTab
            key={item.key}
            tabKey={item.key}
            label={item.label}
            icon={item.icon}
            isActive={item.key === activeSettingsSubTab}
            onClick={() => setActiveSettingsSubTab(item.key)}
          />
        ))}
      </div>
    );
  }

  if (taskMode) {
    return (
      <div ref={tabsRowRef} className="tabs-row" data-overflowing={isOverflowing ? 'true' : 'false'}>
        {TASK_HEADER_TABS.map((item) => (
          <ModuleHeaderTab
            key={item.key}
            tabKey={item.key}
            label={item.label}
            icon={item.icon}
            isActive={item.key === activeTaskPage}
            onClick={() => setActiveTaskPage(item.key)}
          />
        ))}
      </div>
    );
  }

  if (crmMode) {
    const isTabActive = (item: CRMHeaderTab) =>
      item.formsPage
        ? activeCRMPage === 'forms' &&
          (activeFormsPage === item.formsPage ||
            (item.alsoActiveFor?.includes(activeFormsPage) ?? false))
        : activeCRMPage === item.crmPage;
    const handleTabClick = (item: CRMHeaderTab): (() => void) => {
      if (item.formsPage) {
        const fp = item.formsPage;
        return () => {
          setActiveCRMPage('forms');
          setActiveFormsPage(fp);
        };
      }
      const cp = item.crmPage;
      return () => setActiveCRMPage(cp);
    };

    return (
      <div ref={tabsRowRef} className="tabs-row" data-overflowing={isOverflowing ? 'true' : 'false'}>
        {CRM_HEADER_TABS.map((item) => (
          <ModuleHeaderTab
            key={item.key}
            tabKey={item.key}
            label={item.label}
            icon={item.icon}
            isActive={isTabActive(item)}
            onClick={handleTabClick(item)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={tabsRowRef}
      className={`tabs-row${dragId ? ' tabs-row--reordering' : ''}`}
      data-overflowing={isOverflowing ? 'true' : 'false'}
    >
      {workspaces.map((ws) => (
        <WorkspaceTab
          key={ws.id}
          workspace={ws}
          isActive={ws.id === activeWorkspaceId}
          onSelect={() => handleSelect(ws.id)}
          onClose={() => deleteWorkspace(ws.id)}
          onRename={(newName) => renameWorkspace(ws.id, newName)}
          charLimit={24}
          colorIndex={ws.colorIndex ?? 0}
          isDragging={dragId === ws.id}
          dragOverSide={dragOverId === ws.id && dragId !== ws.id ? dragOverSide : null}
          onDragStart={(e) => handleDragStart(ws.id, e)}
          onDragOver={(e) => handleDragOver(ws.id, e)}
          onDrop={(e) => handleDrop(ws.id, e)}
          onDragEnd={handleDragEnd}
        />
      ))}
      <button
        id="tab-plus-button"
        type="button"
        title={t('tabs.newDocument') ?? 'New workspace'}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => createWorkspace()}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
