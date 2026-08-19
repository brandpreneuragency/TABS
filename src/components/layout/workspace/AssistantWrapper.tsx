import { forwardRef, type ReactNode } from 'react';

interface AssistantWrapperProps {
  children: ReactNode;
  /** id for #ai-sidebar-panel vs #file-viewer-panel (container queries). */
  contentId?: string;
  /** When true, wrapper stays mounted but is removed from layout (PRD 9.2). */
  hidden?: boolean;
}

/**
 * Top-level assistant/detail wrapper (AI sidebar or file viewer).
 * Stable across swaps — never remounted when order changes.
 * Width is owned by the shell grid track (--assistant-wrapper-width).
 * Inner panel keeps container-name: detail-panel via #ai-sidebar-panel / #file-viewer-panel.
 */
export const AssistantWrapper = forwardRef<HTMLDivElement, AssistantWrapperProps>(
  function AssistantWrapper({ children, contentId, hidden = false }, ref) {
    return (
      <div
        ref={ref}
        id="assistant-wrapper"
        className="assistant-wrapper"
        data-wrapper="assistant"
        hidden={hidden}
        aria-hidden={hidden || undefined}
      >
        <div
          id={contentId ?? 'ai-sidebar-panel'}
          className="assistant-panel relative overflow-h flex-col h-full min-w-0 w-full"
          style={{ padding: '10px' }}
        >
          {children}
        </div>
      </div>
    );
  },
);
