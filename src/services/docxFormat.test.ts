import { describe, expect, it } from 'vitest';
import mammoth from 'mammoth';
import { parseDocx, serializeDocx } from './docxFormat';

describe('docxFormat', () => {
  it('round-trips simple TipTap content through serialize + mammoth parse', async () => {
    const source = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Hello DOCX' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'and plain' },
          ],
        },
      ],
    };

    const bytes = await serializeDocx(source);
    expect(bytes.byteLength).toBeGreaterThan(100);

    const parsed = (await parseDocx(bytes)) as {
      type: string;
      content?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    };

    expect(parsed.type).toBe('doc');
    const flatText = JSON.stringify(parsed);
    expect(flatText).toContain('Hello DOCX');
    expect(flatText).toContain('and plain');
  });

  it('returns an empty paragraph doc for empty content', async () => {
    const bytes = await serializeDocx({ type: 'doc', content: [] });
    const parsed = (await parseDocx(bytes)) as {
      type: string;
      content?: unknown[];
    };
    expect(parsed.type).toBe('doc');
    expect(Array.isArray(parsed.content)).toBe(true);
  });

  it('preserves table structure through serialize', async () => {
    const source = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A1' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B1' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A2' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B2' }] }] },
              ],
            },
          ],
        },
      ],
    };

    const bytes = await serializeDocx(source);
    const parsed = (await parseDocx(bytes)) as { content?: Array<{ type?: string }> };

    // The table must survive as a table node — not collapse into a run-on paragraph.
    const flat = JSON.stringify(parsed);
    expect(flat).toContain('"table"');
    expect(flat).toContain('A1');
    expect(flat).toContain('B2');
    // Cells must stay separated (regression guard against "A1B1A2B2").
    expect(flat).not.toContain('A1B1');
  });

  it('embeds an image on serialize (not dropped)', async () => {
    // 1x1 transparent PNG.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const source = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'image', attrs: { src: png } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };

    // Verify the image survives serialization by reading the docx back with
    // mammoth (environment-independent). We intentionally do NOT round-trip via
    // parseDocx here: jsdom + ProseMirror drop data-URL <img> during
    // generateJSON, a test-only quirk that does not occur in the Chromium webview.
    const bytes = await serializeDocx(source);
    const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });

    expect(html).toContain('<img');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });
});
