/**
 * Desktop shell geometry constants and pure clamp helpers.
 * Used by resize hooks and shell CSS track formulas (Phase 5).
 * Responsive/drawer behavior is intentionally out of scope here.
 */

export const ASSISTANT_MIN_PX = 320;
export const PRIMARY_MIN_PX = 140;
/** Center editor / detail column floor when two primary panels are open. */
export const CENTER_MIN_PX = 400;
export const HANDLE_WIDTH_PX = 6;

/** Contextual panel visual bounds (PRD 14.3). */
export const CONTEXT_MIN_PX = 260;
export const CONTEXT_MAX_PX = 420;

export const KEYBOARD_RESIZE_STEP_PX = 16;
export const KEYBOARD_RESIZE_STEP_LARGE_PX = 48;

/** Primary floor when context + center are both visible. */
export const TWO_PANEL_PRIMARY_MIN_PX =
  CONTEXT_MIN_PX + HANDLE_WIDTH_PX + CENTER_MIN_PX;

/** Primary min used when clamping the assistant against shell width. */
export function primaryMinPxForContext(contextPanelVisible: boolean): number {
  return contextPanelVisible ? TWO_PANEL_PRIMARY_MIN_PX : PRIMARY_MIN_PX;
}

/**
 * When the main handle changes primary width, split the delta equally between
 * context and center. If center would drop below CENTER_MIN_PX, pin it and give
 * the rest of the delta to context (then clamp context to its visual range).
 */
export function contextWidthAfterAssistantResizePx(args: {
  startContextPx: number;
  startPrimaryPx: number;
  nextPrimaryPx: number;
  handleWidthPx?: number;
  startCenterPx?: number;
}): number {
  const handle = args.handleWidthPx ?? HANDLE_WIDTH_PX;
  const startCenter =
    args.startCenterPx ??
    args.startPrimaryPx - args.startContextPx - handle;
  const delta = args.nextPrimaryPx - args.startPrimaryPx;
  const equalCenter = startCenter + delta / 2;
  const equalContext = args.startContextPx + delta / 2;

  if (equalCenter < CENTER_MIN_PX) {
    return clampContextWidthPx(
      args.nextPrimaryPx - handle - CENTER_MIN_PX,
      args.nextPrimaryPx,
      handle,
    );
  }
  return clampContextWidthPx(equalContext, args.nextPrimaryPx, handle);
}

/**
 * Clamp assistant width in px against shell geometry.
 * max = shell - primaryMin - handle
 */
export function clampAssistantWidthPx(
  widthPx: number,
  shellWidthPx: number,
  handleWidthPx: number = HANDLE_WIDTH_PX,
  primaryMinPx: number = PRIMARY_MIN_PX,
  assistantMinPx: number = ASSISTANT_MIN_PX,
): number {
  if (!Number.isFinite(widthPx)) return assistantMinPx;
  const maxWidth = Math.max(
    assistantMinPx,
    shellWidthPx - primaryMinPx - handleWidthPx,
  );
  return Math.min(Math.max(widthPx, assistantMinPx), maxWidth);
}

/**
 * Clamp contextual panel width in px.
 * Honors 260–420 visual range and keeps center above its minimum
 * when primary width is known.
 */
export function clampContextWidthPx(
  widthPx: number,
  primaryWidthPx?: number,
  handleWidthPx: number = HANDLE_WIDTH_PX,
  centerMinPx: number = CENTER_MIN_PX,
  contextMinPx: number = CONTEXT_MIN_PX,
  contextMaxPx: number = CONTEXT_MAX_PX,
): number {
  if (!Number.isFinite(widthPx)) return contextMinPx;

  let maxWidth = contextMaxPx;
  if (primaryWidthPx != null && Number.isFinite(primaryWidthPx) && primaryWidthPx > 0) {
    const maxByPrimary = primaryWidthPx - centerMinPx - handleWidthPx;
    if (Number.isFinite(maxByPrimary)) {
      maxWidth = Math.min(contextMaxPx, Math.max(contextMinPx, maxByPrimary));
    }
  }

  const minWidth = Math.min(contextMinPx, maxWidth);
  return Math.min(Math.max(widthPx, minWidth), maxWidth);
}

/** Convert px width to viewport-width percentage for store persistence. */
export function pxToVw(px: number, viewportWidthPx: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    return 0;
  }
  return (px / viewportWidthPx) * 100;
}

/** Convert store vw to px for geometry math. */
export function vwToPx(vw: number, viewportWidthPx: number): number {
  if (!Number.isFinite(vw) || !Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    return 0;
  }
  return (vw / 100) * viewportWidthPx;
}

/**
 * Keyboard/pointer growth sign for assistant width.
 * Normal (assistant right): positive clientX delta shrinks assistant → growSign -1
 * Swapped (assistant left): positive clientX delta grows assistant → growSign +1
 */
export function assistantGrowSign(swapped: boolean): 1 | -1 {
  return swapped ? 1 : -1;
}

/**
 * Apply keyboard delta to assistant width.
 * ArrowRight increases clientX direction; ArrowLeft decreases.
 */
export function applyAssistantKeyboardDelta(
  currentWidthPx: number,
  key: 'ArrowLeft' | 'ArrowRight',
  swapped: boolean,
  stepPx: number,
): number {
  const dx = key === 'ArrowRight' ? stepPx : -stepPx;
  return currentWidthPx + dx * assistantGrowSign(swapped);
}

/**
 * Context panel is always on the leading edge of primary (left in LTR).
 * ArrowRight grows context; ArrowLeft shrinks.
 */
export function applyContextKeyboardDelta(
  currentWidthPx: number,
  key: 'ArrowLeft' | 'ArrowRight',
  stepPx: number,
): number {
  const dx = key === 'ArrowRight' ? stepPx : -stepPx;
  return currentWidthPx + dx;
}
