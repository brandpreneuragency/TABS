import { X } from 'lucide-react';
import type { Task } from '../../types';

interface TaskTabProps {
  task: Task | null;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  charLimit: number;
  colorIndex: number;
}

export function TaskTab({ task, isActive, onSelect, onClose, charLimit }: TaskTabProps) {
  const title = task ? task.title.slice(0, charLimit) + (task.title.length > charLimit ? '…' : '') : 'New tab';
  const idPart = task ? task.id : 'empty';
  return (
    <div
      id={`tab-task-${isActive ? 'active' : 'passive'}-${idPart}`}
      onClick={onSelect}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={`group relative justify-start min-w-0 pl-3 pr-1.5 ${isActive ? 'tab-active' : 'tab-passive'}`}
    >
      <span className="txt-xs med trunc">{title}</span>

      <button
        type="button"
        title="Close task"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="tab-close"
      >
        <X size={10} />
      </button>
    </div>
  );
}
