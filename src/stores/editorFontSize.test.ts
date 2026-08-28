import { describe, expect, it } from 'vitest';
import {
  canStepEditorFontSize,
  parseEditorFontSize,
  stepEditorFontSize,
} from './editorFontSize';

describe('parseEditorFontSize', () => {
  it('accepts the 12/14/16 tokens', () => {
    expect(parseEditorFontSize(12)).toBe(12);
    expect(parseEditorFontSize(14)).toBe(14);
    expect(parseEditorFontSize('16')).toBe(16);
  });

  it('falls back to 12 for unknown values', () => {
    expect(parseEditorFontSize(13)).toBe(12);
    expect(parseEditorFontSize(null)).toBe(12);
  });
});

describe('stepEditorFontSize', () => {
  it('steps 12 → 14 → 16 and back', () => {
    expect(stepEditorFontSize(12, 1)).toBe(14);
    expect(stepEditorFontSize(14, 1)).toBe(16);
    expect(stepEditorFontSize(16, -1)).toBe(14);
    expect(stepEditorFontSize(14, -1)).toBe(12);
  });

  it('clamps at the token bounds', () => {
    expect(stepEditorFontSize(12, -1)).toBe(12);
    expect(stepEditorFontSize(16, 1)).toBe(16);
    expect(canStepEditorFontSize(12, -1)).toBe(false);
    expect(canStepEditorFontSize(16, 1)).toBe(false);
    expect(canStepEditorFontSize(12, 1)).toBe(true);
  });
});
