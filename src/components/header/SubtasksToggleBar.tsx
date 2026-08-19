import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Circle, ArrowUpDown } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useTaskStore } from '../../stores/taskStore';
import { TaskMetadataControls } from '../taskManager/TaskMetadataControls';
import { TASK_TITLE_MAX_LENGTH } from '../../types';

export function SubtasksToggleBar() {
  const { taskMode, activeTaskPage, activeTaskId, subtasksOpen, setSubtasksOpen } = useUIStore();
  const storeActiveId = useTaskStore((s) => s.activeTaskId);
  const tasks = useTaskStore((s) => s.tasks);
  const updateTask = useTaskStore((s) => s.updateTask);

  const effectiveId = activeTaskId ?? storeActiveId;
  const activeTask = tasks.find((t) => t.id === effectiveId) ?? null;
  const isCompleted = activeTask?.status === 'completed';

  const [localTitle, setLocalTitle] = useState(activeTask?.title ?? '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalTitle(activeTask?.title ?? ''); // eslint-disable-line react-hooks/set-state-in-effect -- sync draft title when active task changes
  }, [activeTask?.id, activeTask?.title]);

  useEffect(() => {
    if (isEditingTitle) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isEditingTitle]);

  if (!taskMode) return null;
  // The "Projects" tab shows a full-width kanban board in the center panel;
  // the task-detail subtasks bar does not apply there.
  if (activeTaskPage === 'projects') return null;
  // No selected task: keep the context-panel toggle reachable above the empty state.
  if (!activeTask) {
    return null;
  }

  const startEditingTitle = () => {
    setLocalTitle(activeTask?.title ?? '');
    setIsEditingTitle(true);
  };

  const commit = () => {
    if (!activeTask) return;
    const next = localTitle.trim();
    if (next !== activeTask.title) {
      updateTask(activeTask.id, { title: next });
    }
    setIsEditingTitle(false);
  };

  const cancelTitleEdit = () => {
    setLocalTitle(activeTask?.title ?? '');
    setIsEditingTitle(false);
  };

  const toggleComplete = () => {
    if (!activeTask) return;
    updateTask(activeTask.id, { status: isCompleted ? 'in_progress' : 'completed' });
  };

  return (
    <div
      className="subtasks-toggle-bar"
    >
      <div className="subtasks-toggle-bar-inner">
        <div className="subtasks-toggle-bar-row">
          <button
            type="button"
            className={`subtasks-complete-btn${isCompleted ? ' subtasks-complete-btn--completed' : ''}`}
            onClick={toggleComplete}
            disabled={!activeTask}
            title={isCompleted ? 'Mark as Incomplete' : 'Mark as Completed'}
            aria-label={isCompleted ? 'Mark as Incomplete' : 'Mark as Completed'}
          >
            {isCompleted ? <CheckCircle2 size={16} /> : <Circle size={16} />}
          </button>

          {isEditingTitle ? (
            <input
              ref={inputRef}
              type="text"
              className="subtasks-title-input"
              value={localTitle}
              onChange={(e) => setLocalTitle(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelTitleEdit();
                }
              }}
              placeholder="Untitled task"
              aria-label="Task title"
              spellCheck={false}
              maxLength={TASK_TITLE_MAX_LENGTH}
            />
          ) : (
            <button
              type="button"
              className="subtasks-title-input"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startEditingTitle}
              title="Click to rename"
            >
              {activeTask?.title || 'Untitled task'}
            </button>
          )}

          <TaskMetadataControls />
          <button
            type="button"
            className="tdp-meta-swap-btn"
            onClick={() => setSubtasksOpen(!subtasksOpen)}
            title={subtasksOpen ? 'Hide subtasks' : 'Show subtasks'}
            aria-label={subtasksOpen ? 'Hide subtasks' : 'Show subtasks'}
          >
            <ArrowUpDown size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
