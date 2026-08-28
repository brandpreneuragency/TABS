import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Zap } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { db } from '../../services/db';
import type { QuickPrompt } from '../../types';

function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

interface QuickPromptsProps {
  onSelectPrompt: (prompt: string) => void;
}

export function QuickPrompts({ onSelectPrompt }: QuickPromptsProps) {
  const { activeModal, setActiveModal } = useUIStore();
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [adding, setAdding] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    if (activeModal === 'quickPrompts') {
      db.quickPrompts
        .where('scope')
        .equals('general')
        .reverse()
        .sortBy('createdAt')
        .then(setPrompts);
    }
  }, [activeModal]);

  if (activeModal !== 'quickPrompts') return null;

  const handleAdd = async () => {
    if (!newTitle.trim() || !newPrompt.trim()) return;
    const qp: QuickPrompt = {
      id: shortId(),
      title: newTitle.trim(),
      prompt: newPrompt.trim(),
      scope: 'general',
      createdAt: Date.now(),
    };
    await db.quickPrompts.put(qp);
    setPrompts((prev) => [qp, ...prev]);
    setNewTitle('');
    setNewPrompt('');
    setAdding(false);
  };

  const handleDelete = async (id: string) => {
    await db.quickPrompts.delete(id);
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSelect = (prompt: string) => {
    onSelectPrompt(prompt);
    setActiveModal(null);
  };

  return (
    <div className="overlay" id="quick-prompts-overlay">
      <div className="modal modal--sm flex-col" id="quick-prompts-modal" style={{ maxHeight: 'var(--modal-max-height)' }}>
        <div className="modal-head shrink-0">
          <h2>Quick Prompts</h2>
          <div className="row gap-2">
            <button
              id="quick-prompts-add-btn"
              onClick={() => setAdding((v) => !v)}
              className="row-xs"
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--c-accent-center-panel)',
                fontWeight: 500,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                transition: 'color 0.15s',
              }}
            >
              <Plus size={13} /> Add
            </button>
            <button
              id="quick-prompts-close-btn"
              onClick={() => setActiveModal(null)}
              className="modal-close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-a modal-body col gap-2" id="quick-prompts-body">
          {adding && (
            <div
              className="col gap-2"
              style={{
                border: '1px solid rgba(139,92,246,0.3)',
                borderRadius: 12,
                padding: 16,
                background: 'rgba(139,92,246,0.06)',
              }}
            >
              <input
                id="quick-prompt-title-input"
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Prompt title..."
                className="ctrl w-full"
                style={{ fontSize: 'var(--fs-sm)' }}
              />
              <textarea
                id="quick-prompt-text-input"
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder="Prompt text..."
                rows={3}
                className="ctrl w-full"
                style={{ fontSize: 'var(--fs-sm)', resize: 'none' }}
              />
              <div className="row gap-2">
                <button
                  id="quick-prompt-save-btn"
                  onClick={handleAdd}
                  disabled={!newTitle.trim() || !newPrompt.trim()}
                  className="btn-brand flex-1"
                  style={{ fontSize: 'var(--fs-sm)', opacity: (!newTitle.trim() || !newPrompt.trim()) ? 0.4 : 1 }}
                >
                  Save
                </button>
                <button
                  onClick={() => setAdding(false)}
                  className="btn"
                  style={{ fontSize: 'var(--fs-sm)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {prompts.length === 0 && !adding && (
            <div className="subtle" style={{ textAlign: 'center', padding: '32px 0', fontSize: 'var(--fs-sm)' }}>
              No quick prompts saved yet. Add one to get started.
            </div>
          )}

          {prompts.map((qp) => (
            <div
              key={qp.id}
              className="row gap-3 c-ptr"
              style={{
                padding: 12,
                borderRadius: 12,
                border: '1px solid var(--c-border-1)',
                transition: 'border-color 0.15s, background-color 0.15s',
              }}
              onClick={() => handleSelect(qp.prompt)}
              onMouseEnter={() => setHoveredId(qp.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <Zap size={14} style={{ color: 'var(--c-accent-center-panel)', flexShrink: 0, marginTop: 2 }} />
              <div className="flex-1 min-w-0">
                <div className="med" style={{ fontSize: 'var(--fs-sm)' }}>{qp.title}</div>
                <div className="subtle trunc" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>{qp.prompt}</div>
              </div>
              {hoveredId === qp.id && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(qp.id); }}
                  className="btn-icon"
                  style={{ padding: 4 }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
