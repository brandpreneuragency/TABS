import { useRef, type CSSProperties, type ReactNode } from 'react';
import {
  ASSISTANT_MIN_PX,
  HANDLE_WIDTH_PX,
  primaryMinPxForContext,
} from '../../../stores/layoutGeometry';
import { PrimaryWorkspaceWrapper } from './PrimaryWorkspaceWrapper';
import { AssistantWrapper } from './AssistantWrapper';
import { MainResizeHandle } from './MainResizeHandle';
import type { WorkspaceShellLayoutKind } from './types';

interface WorkspaceShellProps {
  primaryWrapperOpen: boolean;
  assistantWrapperOpen: boolean;
  wrappersSwapped: boolean;
  /** Assistant width in vw (store value). */
  assistantWrapperWidthVw: number;
  /** Primary workspace body (PrimaryWorkspaceContent). */
  primary: ReactNode;
  /** Assistant body (subheader + AI, or file viewer). */
  assistant: ReactNode;
  /** id for #ai-sidebar-panel vs #file-viewer-panel (container queries). */
  assistantContentId?: string;
  /** True when primary shows context + center (file tree, task list, …). */
  contextPanelVisible?: boolean;
}

function resolveLayoutKind(
  primaryOpen: boolean,
  assistantOpen: boolean,
): WorkspaceShellLayoutKind {
  if (primaryOpen && assistantOpen) return 'both';
  if (assistantOpen) return 'assistant-only';
  return 'primary-only';
}

/**
 * Top-level horizontal shell: primary | handle | assistant.
 * Wrappers always mount once; CSS grid areas perform swap (no JSX remount).
 * Closed wrappers use `hidden` (display:none) so Settings/editor/chat local
 * state survives hide/show; swap never changes mount identity.
 */
export function WorkspaceShell({
  primaryWrapperOpen,
  assistantWrapperOpen,
  wrappersSwapped,
  assistantWrapperWidthVw,
  primary,
  assistant,
  assistantContentId,
  contextPanelVisible = false,
}: WorkspaceShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);

  const layout = resolveLayoutKind(primaryWrapperOpen, assistantWrapperOpen);
  const bothOpen = layout === 'both';
  // Swapped placement only when both wrappers are open. Grid areas keep
  // this order at every viewport width.
  const swapped = bothOpen && wrappersSwapped;

  const primaryMinPx = primaryMinPxForContext(contextPanelVisible);
  // Shell-relative max leaves primary minimum + handle. 100% is the shell grid.
  const assistantWidthCss = `clamp(${ASSISTANT_MIN_PX}px, ${assistantWrapperWidthVw}vw, calc(100% - ${primaryMinPx}px - ${HANDLE_WIDTH_PX}px))`;

  const style = {
    ['--assistant-wrapper-width' as string]: assistantWidthCss,
    ['--primary-min-width' as string]: `${primaryMinPx}px`,
    ['--assistant-min-width' as string]: `${ASSISTANT_MIN_PX}px`,
    ['--shell-handle-width' as string]: `${HANDLE_WIDTH_PX}px`,
  } as CSSProperties;

  return (
    <div
      ref={shellRef}
      id="workspace-shell"
      className="workspace-shell"
      data-layout={layout}
      data-swapped={swapped ? 'true' : 'false'}
      data-primary-open={primaryWrapperOpen ? 'true' : 'false'}
      data-assistant-open={assistantWrapperOpen ? 'true' : 'false'}
      style={style}
    >
      <PrimaryWorkspaceWrapper ref={primaryRef} hidden={!primaryWrapperOpen}>
        {primary}
      </PrimaryWorkspaceWrapper>

      {bothOpen && (
        <MainResizeHandle
          shellRef={shellRef}
          assistantRef={assistantRef}
          primaryRef={primaryRef}
          swapped={swapped}
        />
      )}

      <AssistantWrapper
        ref={assistantRef}
        contentId={assistantContentId}
        hidden={!assistantWrapperOpen}
      >
        {assistant}
      </AssistantWrapper>
    </div>
  );
}
