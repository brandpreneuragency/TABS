import { describe, expect, it } from 'vitest';
import { canOpenInTipTap, isDocxFile, isTextFile } from './fileType';

describe('docx file type gates', () => {
  it('recognizes .docx as openable but not plain text', () => {
    expect(isDocxFile('brief.docx')).toBe(true);
    expect(isDocxFile('BRIEF.DOCX')).toBe(true);
    expect(isTextFile('brief.docx')).toBe(false);
    expect(canOpenInTipTap('brief.docx')).toBe(true);
  });

  it('rejects non-docx', () => {
    expect(isDocxFile('notes.doc')).toBe(false);
    expect(isDocxFile('notes.md')).toBe(false);
  });
});
