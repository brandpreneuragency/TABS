import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import {
  ASSISTANT_MIN_PX,
  HANDLE_WIDTH_PX,
  KEYBOARD_RESIZE_STEP_LARGE_PX,
  KEYBOARD_RESIZE_STEP_PX,
  PRIMARY_MIN_PX,
  applyAssistantKeyboardDelta,
  clampAssistantWidthPx,
  primaryMinPxForContext,
  pxToVw,
  vwToPx,
} from '../stores/layoutGeometry';
import { useUIStore } from '../stores/uiStore';

function twoPanelPrimaryOpen(primaryEl: HTMLElement | null): boolean {
  if (!primaryEl) return false;
  const context = primaryEl.querySelector('[data-context-panel]');
  const center = primaryEl.querySelector('#center-panel');
  return Boolean(context && center);
}

function persistContextWidthFromDom(
  primaryEl: HTMLElement | null,
  setContextPanelWidth: (w: number, options?: { persist?: boolean }) => void,
) {
  const context = primaryEl?.querySelector('[data-context-panel]') as HTMLElement | null;
  if (!context) return;
  const widthPx = context.getBoundingClientRect().width;
  if (!Number.isFinite(widthPx) || widthPx <= 0) return;
  setContextPanelWidth(pxToVw(widthPx, window.innerWidth), { persist: true });
}

type ResizeKind = 'assistant' | 'context';

function setResizingState(kind: ResizeKind | null) {
  if (kind) {
    document.documentElement.dataset.resizing = kind;
  } else {
    delete document.documentElement.dataset.resizing;
  }
}

/**
 * Resize the assistant/detail wrapper. Always controls assistant width,
 * accounting for which physical side the assistant occupies.
 * Two-panel primary layout shares leftover width equally in CSS
 * (center floor 400px). This hook resizes the assistant and persists the
 * leftover context width when done.
 * Uses explicit refs — never previousElementSibling / nextElementSibling.
 *
 * Drag: update in-memory width only; persist on pointerup/cancel.
 * Keyboard: ArrowLeft/Right (Shift = larger step); persists each step.
 */
export function useAssistantResize(options: {
  shellRef: RefObject<HTMLElement | null>;
  assistantRef: RefObject<HTMLElement | null>;
  primaryRef?: RefObject<HTMLElement | null>;
  swapped: boolean;
}) {
  const { shellRef, assistantRef, primaryRef, swapped } = options;
  const setAssistantWrapperWidth = useUIStore((s) => s.setAssistantWrapperWidth);
  const setContextPanelWidth = useUIStore((s) => s.setContextPanelWidth);
  const dragging = useRef(false);
  const cleanupDrag = useRef<(() => void) | null>(null);

  const endDragSession = useCallback(() => {
    if (cleanupDrag.current) {
      cleanupDrag.current();
      cleanupDrag.current = null;
    }
  }, []);

  useEffect(() => () => endDragSession(), [endDragSession]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const shellEl = shellRef.current;
      const assistantEl = assistantRef.current;
      const handleEl = e.currentTarget;
      if (!shellEl || !assistantEl) return;

      endDragSession();
      dragging.current = true;
      handleEl.setPointerCapture(e.pointerId);

      const assistantRect = assistantEl.getBoundingClientRect();
      const handleWidth = handleEl.getBoundingClientRect().width || HANDLE_WIDTH_PX;
      const twoPanel = twoPanelPrimaryOpen(primaryRef?.current ?? null);
      const primaryMinPx = primaryMinPxForContext(twoPanel);
      const startX = e.clientX;

      // Offset from pointer to the moving (inner) edge of the assistant.
      const pointerToMovingEdge = swapped
        ? assistantRect.right - startX
        : startX - assistantRect.left;
      const fixedEdge = swapped ? assistantRect.left : assistantRect.right;

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      setResizingState('assistant');

      const onPointerMove = (ev: PointerEvent) => {
        if (!dragging.current) return;
        const movingEdge = swapped
          ? ev.clientX + pointerToMovingEdge
          : ev.clientX - pointerToMovingEdge;
        const newWidth = swapped
          ? movingEdge - fixedEdge
          : fixedEdge - movingEdge;

        const shellWidth = shellEl.getBoundingClientRect().width;
        const clampedPx = clampAssistantWidthPx(
          newWidth,
          shellWidth,
          handleWidth,
          primaryMinPx,
        );
        // In-memory only during drag; persist on pointerup.
        setAssistantWrapperWidth(pxToVw(clampedPx, window.innerWidth), { persist: false });
      };

      const endDrag = (ev?: PointerEvent) => {
        if (!dragging.current && !cleanupDrag.current) return;
        dragging.current = false;
        if (ev) {
          try {
            handleEl.releasePointerCapture(ev.pointerId);
          } catch {
            // already released
          }
        }
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setResizingState(null);
        handleEl.removeEventListener('pointermove', onPointerMove);
        handleEl.removeEventListener('pointerup', endDrag);
        handleEl.removeEventListener('pointercancel', endDrag);
        cleanupDrag.current = null;
        const current = useUIStore.getState().assistantWrapperWidth;
        setAssistantWrapperWidth(current, { persist: true });
        if (twoPanel) {
          persistContextWidthFromDom(primaryRef?.current ?? null, setContextPanelWidth);
        }
      };

      cleanupDrag.current = () => endDrag();
      handleEl.addEventListener('pointermove', onPointerMove);
      handleEl.addEventListener('pointerup', endDrag);
      handleEl.addEventListener('pointercancel', endDrag);
    },
    [
      shellRef,
      assistantRef,
      primaryRef,
      swapped,
      setAssistantWrapperWidth,
      setContextPanelWidth,
      endDragSession,
    ],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();

      const shellEl = shellRef.current;
      if (!shellEl) return;

      const step = e.shiftKey ? KEYBOARD_RESIZE_STEP_LARGE_PX : KEYBOARD_RESIZE_STEP_PX;
      const assistantEl = assistantRef.current;
      const currentPx = assistantEl
        ? assistantEl.getBoundingClientRect().width
        : vwToPx(useUIStore.getState().assistantWrapperWidth, window.innerWidth);
      const nextRaw = applyAssistantKeyboardDelta(currentPx, e.key, swapped, step);
      const handleWidth =
        e.currentTarget.getBoundingClientRect().width || HANDLE_WIDTH_PX;
      const shellWidth = shellEl.getBoundingClientRect().width;
      const twoPanel = twoPanelPrimaryOpen(primaryRef?.current ?? null);
      const primaryMinPx = primaryMinPxForContext(twoPanel);
      const clampedPx = clampAssistantWidthPx(
        nextRaw,
        shellWidth,
        handleWidth,
        primaryMinPx,
      );
      setAssistantWrapperWidth(pxToVw(clampedPx, window.innerWidth), { persist: true });
      if (twoPanel) {
        requestAnimationFrame(() => {
          persistContextWidthFromDom(primaryRef?.current ?? null, setContextPanelWidth);
        });
      }
    },
    [shellRef, assistantRef, primaryRef, swapped, setAssistantWrapperWidth, setContextPanelWidth],
  );

  return {
    onPointerDown,
    onKeyDown,
    ariaValueMin: ASSISTANT_MIN_PX,
    ariaValueMaxHint: PRIMARY_MIN_PX,
  };
}
