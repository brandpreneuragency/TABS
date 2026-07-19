import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  CalendarDays,
  CheckCircle2,
  FolderPlus,
  GripVertical,
  List,
  ListTodo,
  Plus,
  Users,
} from 'lucide-react';
import '../crm/crm.css';
import './taskProjectsKanban.css';
import './taskDetail.css';
import { dateOptions } from './taskMetadataUtils';
import { useTaskStore } from '../../stores/taskStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { KPICard, CRMEmptyState } from '../crm/components';
import type { Task } from '../../types';

const PROJECT_DOT_COLORS: Record<string, string> = {
  'text-blue-500': '#3b82f6',
  'text-emerald-500': '#10b981',
  'text-amber-500': '#f59e0b',
  'text-rose-500': '#f43f5e',
  'text-violet-500': '#8b5cf6',
  'text-cyan-500': '#06b6d4',
  'text-orange-500': '#f97316',
  'text-pink-500': '#ec4899',
};

const UNCATEGORIZED_ID = '__none__';

function projectDotColor(color?: string): string {
  return (color && PROJECT_DOT_COLORS[color]) || 'var(--c-text-3)';
}

function isOverdue(t: Task): boolean {
  if (t.status === 'completed' || !t.date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(t.date);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

interface Column {
  id: string; // project id or UNCATEGORIZED_ID
  name: string;
  color?: string;
  tasks: Task[];
}

interface TaskKanbanCardProps {
  task: Task;
  isActive: boolean;
  onClick: (taskId: string) => void;
}

function TaskKanbanCard({ task, isActive, onClick }: TaskKanbanCardProps) {
  const updateTask = useTaskStore((s) => s.updateTask);
  const openTaskInActiveTab = useTaskStore((s) => s.openTaskInActiveTab);
  const setActiveTaskPage = useUIStore((s) => s.setActiveTaskPage);
  const [isDragging, setIsDragging] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showDatePicker) return;
    const onDocClick = (e: MouseEvent) => {
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) {
        setShowDatePicker(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showDatePicker]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.setData('application/x-task-card', task.id);
    setIsDragging(true);
  };

  const handleOpenInList = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveTaskPage('list');
    openTaskInActiveTab(task.id);
  };

  return (
    <div
      className={`crm-kanban-card${isActive ? ' crm-kanban-card--active' : ''}${isDragging ? ' crm-kanban-card--dragging' : ''}`}
      draggable
      role="button"
      tabIndex={0}
      onClick={() => onClick(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(task.id);
        }
      }}
      onDragStart={handleDragStart}
      onDragEnd={() => setIsDragging(false)}
    >
      <div
        className="crm-kanban-card-drag"
        title="Drag to move project"
        draggable
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.stopPropagation();
          handleDragStart(e);
        }}
      >
        <GripVertical size={12} />
      </div>
      <div className="crm-kanban-card-title-zone">
        <span className="crm-kanban-card-title">{task.title}</span>
        <button
          type="button"
          className="crm-kanban-card-edit"
          title="Open in List"
          aria-label="Open in List"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleOpenInList}
        >
          <List size={12} />
        </button>
      </div>
      <div className="crm-kanban-card-primary">
        <div
          ref={dateRef}
          className="tdp-meta-field"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tdp-meta-field-btn"
            onClick={() => setShowDatePicker(!showDatePicker)}
            title={task.date ? `Due: ${task.date}` : 'Set due date'}
            style={{ color: task.date ? 'var(--c-text-1)' : 'var(--c-text-2)' }}
          >
            <Calendar size={12} />
            <span className="tdp-meta-field-label">
              {task.date ? task.date : 'No due date'}
            </span>
          </button>
          {showDatePicker && (
            <div className="drop" style={{ position: 'absolute', top: '100%', left: 0, minWidth: 160, marginTop: 2, zIndex: 1000 }}>
              {dateOptions().map((opt) => (
                <button
                  key={opt.value || '__empty__'}
                  type="button"
                  className="drop-item"
                  onClick={() => { updateTask(task.id, { date: opt.value }); setShowDatePicker(false); }}
                  style={{ fontSize: 'var(--fs-base)' }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {task.assignees.length > 0 && (
        <div className="crm-kanban-card-footer">
          <span className="crm-kanban-card-meta-item">
            <Users size={11} />
            <span className="trunc">{task.assignees.length}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function TaskProjectsKanban() {
  const tasks = useTaskStore((s) => s.tasks);
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const updateTask = useTaskStore((s) => s.updateTask);
  const createTask = useTaskStore((s) => s.createTask);
  const openTaskInActiveTab = useTaskStore((s) => s.openTaskInActiveTab);
  const { projects, createProject } = useProjectStore();

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingProject) newProjectInputRef.current?.focus();
  }, [addingProject]);

  const rootTasks = useMemo(() => tasks.filter((t) => !t.parentId), [tasks]);

  const metrics = useMemo(() => {
    const total = rootTasks.length;
    const completed = rootTasks.filter((t) => t.status === 'completed').length;
    const overdue = rootTasks.filter(isOverdue).length;
    return { total, completed, overdue };
  }, [rootTasks]);

  const columns: Column[] = useMemo(() => {
    const projectCols: Column[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      tasks: rootTasks.filter((t) => t.projectId === p.id),
    }));
    const uncategorized: Column = {
      id: UNCATEGORIZED_ID,
      name: 'Uncategorized',
      tasks: rootTasks.filter((t) => !t.projectId),
    };
    return [...projectCols, uncategorized];
  }, [projects, rootTasks]);

  const handleAddTask = async (projectId: string | null) => {
    const title = window.prompt('New task title');
    if (!title || !title.trim()) return;
    const created = await createTask(title.trim(), projectId ? { projectId } : {});
    if (created) openTaskInActiveTab(created.id);
  };

  const startAddProject = () => {
    setAddingProject(true);
    setNewProjectName('');
  };

  const cancelAddProject = () => {
    setAddingProject(false);
    setNewProjectName('');
  };

  const submitNewProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    await createProject(name);
    cancelAddProject();
  };

  const handleMove = async (taskId: string, columnId: string) => {
    const target = columnId === UNCATEGORIZED_ID ? null : columnId;
    const task = rootTasks.find((t) => t.id === taskId);
    if (!task || task.projectId === target) return;
    await updateTask(taskId, { projectId: target });
  };

  const newProjectForm = addingProject ? (
    <div className="task-kanban-add-column task-kanban-add-column--form">
      <input
        ref={newProjectInputRef}
        type="text"
        className="task-kanban-add-column-input ctrl"
        value={newProjectName}
        onChange={(e) => setNewProjectName(e.target.value)}
        placeholder="Project name"
        maxLength={80}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submitNewProject();
          if (e.key === 'Escape') cancelAddProject();
        }}
      />
      <div className="task-kanban-add-column-actions">
        <button
          type="button"
          className="crm-btn crm-btn--primary crm-btn--sm"
          disabled={!newProjectName.trim()}
          onClick={() => void submitNewProject()}
        >
          Add
        </button>
        <button type="button" className="crm-btn crm-btn--sm" onClick={cancelAddProject}>
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      className="task-kanban-add-column"
      onClick={startAddProject}
      title="Add project"
    >
      <FolderPlus size={14} />
      <span>New project</span>
    </button>
  );

  if (rootTasks.length === 0 && projects.length === 0) {
    return (
      <div className="crm-page">
        <div className="crm-page-body" style={{ paddingTop: 14 }}>
          {addingProject ? (
            <div className="task-kanban-add-column-empty-wrap">{newProjectForm}</div>
          ) : (
            <CRMEmptyState
              icon={ListTodo}
              title="No tasks or projects yet"
              subtitle="Create a project, then add tasks. Drag cards between columns to reassign them to a project."
              actionLabel="Add project"
              onAction={startAddProject}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="crm-page">
      <div className="crm-page-body" style={{ paddingTop: 14 }}>
        <div className="crm-kpi-row">
          <KPICard
            label="Total Tasks"
            value={metrics.total}
            icon={ListTodo}
            delta={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
            deltaPositive
          />
          <KPICard
            label="Completed"
            value={metrics.completed}
            icon={CheckCircle2}
            delta={`${metrics.total} total`}
            deltaPositive
          />
          <KPICard
            label="Overdue"
            value={metrics.overdue}
            icon={CalendarDays}
            delta={metrics.overdue > 0 ? 'needs attention' : 'on track'}
            deltaPositive={metrics.overdue === 0}
          />
        </div>

        <div className="crm-kanban" onDragEnd={() => setDropTarget(null)}>
          {columns.map((col) => {
            const isDrop = dropTarget === col.id;
            return (
              <div
                key={col.id}
                className={`crm-kanban-column${isDrop ? ' crm-kanban-column--drop-target' : ''}`}
                data-project={col.id}
              >
                <div className="crm-kanban-column-header">
                  <span className="crm-kanban-column-title">
                    <span
                      className="crm-kanban-column-dot"
                      style={{ background: projectDotColor(col.color) }}
                    />
                    {col.name}
                  </span>
                  <span className="crm-kanban-column-count">{col.tasks.length}</span>
                </div>
                <div
                  className="crm-kanban-column-body"
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTarget(col.id);
                  }}
                  onDragLeave={(e) => {
                    const nextTarget = e.relatedTarget;
                    if (!(nextTarget instanceof Node) || !e.currentTarget.contains(nextTarget)) {
                      setDropTarget((cur) => (cur === col.id ? null : cur));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const taskId =
                      e.dataTransfer.getData('application/x-task-card') ||
                      e.dataTransfer.getData('text/plain');
                    setDropTarget(null);
                    if (taskId) {
                      void handleMove(taskId, col.id).catch((err) => {
                        console.error('[TaskProjectsKanban] Failed to move task:', err);
                      });
                    }
                  }}
                >
                  {col.tasks.length === 0 && (
                    <div className="crm-kanban-column-empty subtle">No tasks</div>
                  )}
                  {col.tasks.map((t) => (
                    <TaskKanbanCard
                      key={t.id}
                      task={t}
                      isActive={t.id === activeTaskId}
                      onClick={openTaskInActiveTab}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="task-kanban-add-btn"
                  onClick={() => handleAddTask(col.id === UNCATEGORIZED_ID ? null : col.id)}
                >
                  <Plus size={12} /> Add task
                </button>
              </div>
            );
          })}
          {newProjectForm}
        </div>
      </div>
    </div>
  );
}
