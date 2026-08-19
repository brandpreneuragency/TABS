import type { RefObject } from 'react';
import { useAssistantResize } from '../../../hooks/useAssistantResize';
import { ASSISTANT_MIN_PX, vwToPx } from '../../../stores/layoutGeometry';
import { useUIStore } from '../../../stores/uiStore';

interface MainResizeHandleProps {
  shellRef: RefObject<HTMLElement | null>;
  assistantRef: RefObject<HTMLElement | null>;
  primaryRef: RefObject<HTMLElement | null>;
  swapped: boolean;
}

/** Main resize handle between primary and assistant wrappers. Always resizes assistant.
 *  When primary has two panels, leftover width is taken from the left/context panel. */
export function MainResizeHandle({ shellRef, assistantRef, primaryRef, swapped }: MainResizeHandleProps) {
  const { onPointerDown, onKeyDown } = useAssistantResize({
    shellRef,
    assistantRef,
    primaryRef,
    swapped,
  });
  const widthVw = useUIStore((s) => s.assistantWrapperWidth);

  const viewport =
    typeof window !== 'undefined' ? window.innerWidth : 1200;
  const valueNow = Math.round(vwToPx(widthVw, viewport));
  // Static upper bound for aria (live max is enforced in the resize hook).
  // Avoid reading shellRef during render (React purity / eslint).
  const valueMax = Math.max(ASSISTANT_MIN_PX, Math.round(viewport * 0.75));

  return (
    <div
      id="main-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize assistant panel"
      aria-valuemin={ASSISTANT_MIN_PX}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      title="Drag or use arrow keys to resize assistant"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="main-resize-handle resize-handle workspace-handle"
    >
      <div className="main-resize-handle__line" />
    </div>
  );
}
