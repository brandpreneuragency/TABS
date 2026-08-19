import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { CONTEXT_MAX_PX, CONTEXT_MIN_PX } from '../../../stores/layoutGeometry';
import type { WorkspaceMode } from '../../../stores/uiLayoutState';

interface ContextualPanelProps {
  mode: WorkspaceMode;
  widthVw: number;
  children: ReactNode;
  /** When true, the parent grid sizes this track; skip the explicit vw width. */
  fillRemaining?: boolean;
  /** Optional stable id for mode-specific panels (file-tree, task-list, …). */
  panelId?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared contextual (list/tree) panel host inside the primary wrapper.
 * Owns width application and container-query host class.
 */
export const ContextualPanel = forwardRef<HTMLDivElement, ContextualPanelProps>(
  function ContextualPanel(
    { mode, widthVw, children, fillRemaining = false, panelId, className = '', style },
    ref,
  ) {
    return (
      <div
        ref={ref}
        id={panelId}
        className={`contextual-panel task-list-panel relative overflow-h flex-col h-full min-w-0 ${className}`.trim()}
        data-workspace-mode={mode}
        data-context-panel=""
        style={{
          ...(fillRemaining
            ? { width: '100%', minWidth: 0, maxWidth: 'none' }
            : { width: `clamp(${CONTEXT_MIN_PX}px, ${widthVw}vw, ${CONTEXT_MAX_PX}px)` }),
          minHeight: 0,
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);
