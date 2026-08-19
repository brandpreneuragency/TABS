import { useRef, type CSSProperties, type ReactNode } from 'react';
import {
  CENTER_MIN_PX,
  CONTEXT_MAX_PX,
  CONTEXT_MIN_PX,
} from '../../../stores/layoutGeometry';
import type { WorkspaceMode } from '../../../stores/uiLayoutState';
import { ContextualPanel } from './ContextualPanel';
import { ContextResizeHandle } from './ContextResizeHandle';
import { CenterContentPanel } from './CenterContentPanel';

interface PrimaryWorkspaceContentProps {
  mode: WorkspaceMode;
  contextPanel?: ReactNode | null;
  centerPanel: ReactNode;
  contextPanelAvailable: boolean;
  contextPanelOpen: boolean;
  contextPanelWidthVw: number;
  contextPanelId?: string;
  contextPanelClassName?: string;
  contextPanelStyle?: CSSProperties;
  subtasksBar?: ReactNode;
  showSubtasksBar?: boolean;
  leadingControls?: ReactNode;
}

/**
 * Internal primary layout: optional contextual panel + context handle + center.
 * Two-panel mode shares leftover width equally (1fr / 1fr). Center never goes
 * below 400px; context never goes below 260px.
 */
export function PrimaryWorkspaceContent({
  mode,
  contextPanel,
  centerPanel,
  contextPanelAvailable,
  contextPanelOpen,
  contextPanelWidthVw,
  contextPanelId,
  contextPanelClassName,
  contextPanelStyle,
  subtasksBar,
  showSubtasksBar,
  leadingControls,
}: PrimaryWorkspaceContentProps) {
  const contextRef = useRef<HTMLDivElement>(null);
  const primaryContentRef = useRef<HTMLDivElement>(null);
  const showContext = contextPanelAvailable && contextPanelOpen && contextPanel != null;

  const rowStyle = {
    ['--context-min-width' as string]: `${CONTEXT_MIN_PX}px`,
    ['--context-max-width' as string]: `${CONTEXT_MAX_PX}px`,
    ['--center-min-width' as string]: `${CENTER_MIN_PX}px`,
    ['--context-panel-width' as string]: `clamp(${CONTEXT_MIN_PX}px, ${contextPanelWidthVw}vw, ${CONTEXT_MAX_PX}px)`,
  } as CSSProperties;

  return (
    <div
      ref={primaryContentRef}
      className="primary-workspace-content"
      data-two-panel={showContext ? 'true' : 'false'}
      style={rowStyle}
    >
      {showContext && (
        <ContextualPanel
          ref={contextRef}
          mode={mode}
          widthVw={contextPanelWidthVw}
          fillRemaining={showContext}
          panelId={contextPanelId}
          className={contextPanelClassName}
          style={contextPanelStyle}
        >
          {contextPanel}
        </ContextualPanel>
      )}
      {showContext && (
        <ContextResizeHandle
          contextRef={contextRef}
          primaryContentRef={primaryContentRef}
        />
      )}
      <CenterContentPanel
        subtasksBar={subtasksBar}
        showSubtasksBar={showSubtasksBar}
        leadingControls={leadingControls}
      >
        {centerPanel}
      </CenterContentPanel>
    </div>
  );
}
