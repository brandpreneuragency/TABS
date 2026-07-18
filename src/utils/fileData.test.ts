import { describe, expect, it } from 'vitest';
import { bytesToDataUrl, mimeTypeFromPath, uint8ToBase64 } from './fileData';

describe('uint8ToBase64 / bytesToDataUrl', () => {
  it('encodes bytes to base64', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(uint8ToBase64(bytes)).toBe(btoa('hello'));
  });

  it('builds a data URL', () => {
    const bytes = new TextEncoder().encode('hi');
    expect(bytesToDataUrl(bytes, 'text/plain')).toBe(
      `data:text/plain;base64,${btoa('hi')}`,
    );
  });
});

describe('mimeTypeFromPath', () => {
  it('maps common image and document extensions', () => {
    expect(mimeTypeFromPath('C:\\Users\\a\\photo.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromPath('/tmp/note.md')).toBe('text/markdown');
    expect(mimeTypeFromPath('readme.txt')).toBe('text/plain');
    expect(mimeTypeFromPath('scan.PDF')).toBe('application/pdf');
    expect(mimeTypeFromPath('x.png')).toBe('image/png');
  });

  it('falls back for unknown extensions', () => {
    expect(mimeTypeFromPath('file.xyz')).toBe('application/octet-stream');
  });
});
