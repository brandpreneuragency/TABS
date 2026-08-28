import { useEffect, useMemo, useState } from 'react';
import { Plus, FolderPlus, Trash2, GripVertical, Folder, FolderOpen } from 'lucide-react';
import { useActionsStore } from '../../stores/actionsStore';
import { SettingsPanels } from './SettingsPanels';
import type { QuickPrompt } from '../../types';

interface DragData { actionId: string }
interface DropTarget { groupId: string | null; index: number }
interface ContextMenu { x: number; y: number; actionId: string }

export function ActionsSection() {
  const { actions, groups, reload, saveAction, deleteAction, createGroup, renameGroup, deleteGroup, moveAction, reorderActions } = useActionsStore();

  useEffect(() => { void reload(); }, [reload]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragData | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const rootActions = useMemo(() => actions.filter((a) => !a.groupId), [actions]);
  const actionsInGroup = (gid: string) => actions.filter((a) => a.groupId === gid);
  const selected = selectedId ? actions.find((a) => a.id === selectedId) ?? null : null;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const handleNewAction = async () => {
    const a = await saveAction({ title: 'Untitled action', prompt: '', icon: '' });
    setSelectedId(a.id);
  };

  const commitDrop = (targetGroupId: string | null, index: number | null) => {
    if (!drag) return;
    const draggedId = drag.actionId;
    const targetList = targetGroupId === null ? rootActions : actionsInGroup(targetGroupId);
    const orderedIds = targetList.map((a) => a.id).filter((id) => id !== draggedId);
    const insertAt = index === null ? orderedIds.length : Math.max(0, Math.min(index, orderedIds.length));
    orderedIds.splice(insertAt, 0, draggedId);
    void reorderActions(targetGroupId, orderedIds);
    setDrag(null);
    setDropTarget(null);
  };

  const renderActionRow = (a: QuickPrompt, groupId: string | null, index: number) => {
    const isDropBefore = dropTarget && dropTarget.groupId === groupId && dropTarget.index === index;
    return (
      <div
        key={a.id}
        data-action-row={a.id}
        draggable
        onDragStart={() => setDrag({ actionId: a.id })}
        onDragEnd={() => { setDrag(null); setDropTarget(null); }}
        onDragOver={(e) => { e.preventDefault(); setDropTarget({ groupId, index }); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); commitDrop(groupId, index); }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, actionId: a.id }); }}
        onClick={() => setSelectedId(a.id)}
        className={`settings-action-row${selectedId === a.id ? ' settings-list-item--active' : ''}${drag?.actionId === a.id ? ' is-dragging' : ''}${isDropBefore ? ' is-drop-target' : ''}`}
      >
        <GripVertical size={12} className="settings-drag-handle" />
        <span className="settings-list-item-title">{a.title}</span>
      </div>
    );
  };

  const leftMain = (
    <div className="settings-list-body">
      <button className="settings-add-btn" onClick={handleNewAction}><Plus size={14} /> New action</button>

      {groups.map((g) => {
        const items = actionsInGroup(g.id);
        const isCollapsed = collapsed.has(g.id);
        return (
          <div
            key={g.id}
            className="settings-action-group"
            onDragOver={(e) => { if (drag) e.preventDefault(); }}
            onDrop={(e) => { if (drag) { e.preventDefault(); commitDrop(g.id, items.length); } }}
          >
            <div className="settings-action-group-head" onClick={() => toggleGroup(g.id)}>
              {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
              {renamingGroupId === g.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => { void renameGroup(g.id, renameValue); setRenamingGroupId(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { void renameGroup(g.id, renameValue); setRenamingGroupId(null); } }}
                  className="ctrl"
                  style={{ fontSize: 'var(--fs-base)', padding: '2px 6px', flex: 1 }}
                />
              ) : (
                <span
                  style={{ flex: 1 }}
                  onDoubleClick={(e) => { e.stopPropagation(); setRenamingGroupId(g.id); setRenameValue(g.name); }}
                >
                  {g.name} <span className="settings-list-item-meta">({items.length})</span>
                </span>
              )}
              <button
                className="btn-icon"
                title="Delete group (actions move to root)"
                onClick={(e) => { e.stopPropagation(); void deleteGroup(g.id, false); }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {!isCollapsed && (
              <div className="settings-action-group-body">
                {items.map((a, i) => renderActionRow(a, g.id, i))}
                {items.length === 0 && (
                  <div className="subtle" style={{ fontSize: 'var(--fs-base)', padding: '6px 10px' }}>Drag actions here</div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div
        style={{ marginTop: 6 }}
        onDragOver={(e) => { if (drag) e.preventDefault(); }}
        onDrop={(e) => { if (drag) { e.preventDefault(); commitDrop(null, null); } }}
      >
        {rootActions.map((a, i) => renderActionRow(a, null, i))}
        {rootActions.length === 0 && groups.length === 0 && (
          <div className="settings-empty">No actions yet. Create one above.</div>
        )}
      </div>
    </div>
  );

  const centerMain = (
    <ActionDetail
      action={selected}
      groups={groups}
      onSave={async (patch) => { if (selected) await saveAction({ ...patch, id: selected.id }); }}
      onDelete={async () => { if (selected) { await deleteAction(selected.id); setSelectedId(null); } }}
    />
  );

  return (
    <>
      <SettingsPanels
        leftMain={leftMain}
        centerMain={centerMain}
      />
      {menu && (
        <div
          className="settings-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => { void createGroup('New group'); setMenu(null); }}><FolderPlus size={14} /> New group</button>
          {groups.length > 0 && <div style={{ height: 1, background: 'var(--c-border-1)', margin: '4px 0' }} />}
          {groups.map((g) => (
            <button key={g.id} onClick={() => { void moveAction(menu.actionId, g.id, actionsInGroup(g.id).length); setMenu(null); }}>
              <Folder size={14} /> → {g.name}
            </button>
          ))}
          {actions.find((a) => a.id === menu.actionId)?.groupId && (
            <button onClick={() => { void moveAction(menu.actionId, null, rootActions.length); setMenu(null); }}>
              <FolderOpen size={14} /> Remove from group
            </button>
          )}
          <div style={{ height: 1, background: 'var(--c-border-1)', margin: '4px 0' }} />
          <button onClick={() => { void deleteAction(menu.actionId); setMenu(null); }} style={{ color: 'var(--c-danger)' }}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </>
  );
}

interface ActionDetailProps {
  action: QuickPrompt | null;
  groups: { id: string; name: string }[];
  onSave: (patch: Partial<QuickPrompt>) => Promise<void>;
  onDelete: () => Promise<void>;
}

function ActionDetail({ action, groups, onSave, onDelete }: ActionDetailProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [icon, setIcon] = useState('');
  const [groupId, setGroupId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (action) {
      setTitle(action.title); // eslint-disable-line react-hooks/set-state-in-effect -- hydrate detail form when selection changes
      setPrompt(action.prompt);
      setIcon(action.icon ?? '');
      setGroupId(action.groupId);
    }
  }, [action]);

  if (!action) {
    return <div className="settings-empty">Select an action to edit, or create a new one.</div>;
  }

  return (
    <div className="settings-detail-body">
      <div>
        <label className="semibold" style={{ display: 'block', fontSize: 'var(--fs-base)', color: 'var(--c-text-2)', marginBottom: 6 }}>Title</label>
        <input className="ctrl w-full" style={{ fontSize: 'var(--fs-base)' }} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="semibold" style={{ display: 'block', fontSize: 'var(--fs-base)', color: 'var(--c-text-2)', marginBottom: 6 }}>Prompt</label>
        <textarea className="ctrl w-full" rows={8} style={{ fontSize: 'var(--fs-base)', resize: 'vertical', lineHeight: 1.625 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="row gap-3" style={{ gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="semibold" style={{ display: 'block', fontSize: 'var(--fs-base)', color: 'var(--c-text-2)', marginBottom: 6 }}>Icon (lucide name)</label>
          <input className="ctrl w-full" style={{ fontSize: 'var(--fs-base)' }} value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="e.g. Zap" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="semibold" style={{ display: 'block', fontSize: 'var(--fs-base)', color: 'var(--c-text-2)', marginBottom: 6 }}>Group</label>
          <select className="ctrl w-full" style={{ fontSize: 'var(--fs-base)' }} value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value || undefined)}>
            <option value="">— None —</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>
      <div className="row gap-2">
        <button className="btn-brand flex-1" style={{ fontSize: 'var(--fs-base)', padding: '8px 12px' }} onClick={() => void onSave({ title, prompt, icon, groupId })}>
          Save Changes
        </button>
        <button className="btn-icon" style={{ width: 40, border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: 'var(--c-danger)' }} onClick={() => void onDelete()}>
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
