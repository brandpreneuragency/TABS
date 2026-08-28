export const EDITOR_FONT_SIZES = [12, 14, 16] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];
export const DEFAULT_EDITOR_FONT_SIZE: EditorFontSize = 12;

export function isEditorFontSize(value: unknown): value is EditorFontSize {
  return EDITOR_FONT_SIZES.some((size) => size === value);
}

export function parseEditorFontSize(value: unknown): EditorFontSize {
  const n = typeof value === 'number' ? value : Number(value);
  return isEditorFontSize(n) ? n : DEFAULT_EDITOR_FONT_SIZE;
}

export function stepEditorFontSize(
  current: EditorFontSize,
  direction: 1 | -1,
): EditorFontSize {
  const idx = EDITOR_FONT_SIZES.indexOf(current);
  const next = idx + direction;
  if (next < 0) return EDITOR_FONT_SIZES[0];
  if (next >= EDITOR_FONT_SIZES.length) return EDITOR_FONT_SIZES[EDITOR_FONT_SIZES.length - 1];
  return EDITOR_FONT_SIZES[next];
}

export function canStepEditorFontSize(
  current: EditorFontSize,
  direction: 1 | -1,
): boolean {
  return stepEditorFontSize(current, direction) !== current;
}
