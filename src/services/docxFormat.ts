import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  WidthType,
  Table as DocxTable,
  TableRow as DocxTableRow,
  TableCell as DocxTableCell,
} from 'docx';
import mammoth from 'mammoth';
import { decodeDataUrlBytes } from '../utils/fileData';

/** TipTap extensions used when converting mammoth HTML → editor JSON. */
const DOCX_IMPORT_EXTENSIONS = [
  StarterKit,
  Image,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
];

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Mammoth's Node unzip accepts `{ buffer }`; the browser build accepts
 * `{ arrayBuffer }`. Pass the form that matches the active runtime.
 */
function mammothInput(data: ArrayBuffer | Uint8Array): { buffer: Buffer } | { arrayBuffer: ArrayBuffer } {
  const bytes = toUint8Array(data);
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return { buffer: Buffer.from(bytes) };
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { arrayBuffer: copy.buffer };
}

/**
 * Mammoth wraps images in `<p><img></p>`, but the block-level TipTap Image
 * extension cannot live inside a paragraph — generateJSON silently drops it.
 * Lift each image that is the sole content of a paragraph to a top-level node
 * so it survives as a block image.
 */
function liftImagesOutOfParagraphs(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('p').forEach((p) => {
    const imgs = Array.from(p.querySelectorAll('img'));
    // Only lift pure-image paragraphs (no accompanying text) to avoid reordering.
    if (imgs.length === 0 || (p.textContent ?? '').trim() !== '') return;
    for (const img of imgs) {
      p.parentNode?.insertBefore(img, p);
    }
    p.remove();
  });
  return doc.body.innerHTML;
}

/**
 * Convert a .docx binary into TipTap document JSON via mammoth HTML.
 * Formatting is semantic (not pixel-perfect Word layout).
 */
export async function parseDocx(data: ArrayBuffer | Uint8Array): Promise<object> {
  const { value: html } = await mammoth.convertToHtml(
    mammothInput(data),
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.read('base64');
        return {
          src: `data:${image.contentType};base64,${base64}`,
        };
      }),
    },
  );

  const normalized = liftImagesOutOfParagraphs(html || '<p></p>');

  const json = generateJSON(normalized || '<p></p>', DOCX_IMPORT_EXTENSIONS) as {
    type?: string;
    content?: unknown[];
  };

  if (!json?.type) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  if (!json.content || json.content.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  return json;
}

type InlineNode = {
  type?: string;
  text?: string;
  marks?: { type: string }[];
};

type DocNode = {
  type?: string;
  attrs?: { level?: number; src?: string; alt?: string };
  content?: DocNode[] | InlineNode[];
};

/** docx section/cell children accept both paragraphs and tables. */
type DocxBlock = Paragraph | DocxTable;

function inlineToRuns(inlines: InlineNode[] | undefined): TextRun[] {
  const runs = (inlines ?? []).map((inline) => {
    const marks = inline.marks ?? [];
    return new TextRun({
      text: inline.text ?? '',
      bold: marks.some((m) => m.type === 'bold'),
      italics: marks.some((m) => m.type === 'italic'),
      underline: marks.some((m) => m.type === 'underline') ? {} : undefined,
      strike: marks.some((m) => m.type === 'strike'),
    });
  });
  return runs.length > 0 ? runs : [new TextRun('')];
}

function nodeText(node: DocNode | InlineNode | undefined): string {
  if (!node) return '';
  if ('text' in node && typeof node.text === 'string') return node.text;
  const children = (node as DocNode).content ?? [];
  return (children as Array<DocNode | InlineNode>).map((c) => nodeText(c)).join('');
}

type ImageType = 'png' | 'jpg' | 'gif' | 'bmp';

function imageTypeFromMime(mime: string): ImageType | null {
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/gif/i.test(mime)) return 'gif';
  if (/bmp/i.test(mime)) return 'bmp';
  return null;
}

/** Read intrinsic pixel dimensions from raw image bytes (PNG/JPEG/GIF/BMP). */
function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: IHDR width/height are big-endian at byte 16.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    if (width > 0 && height > 0) return { width, height };
  }
  // GIF: logical screen width/height are little-endian at byte 6.
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  // BMP: width/height are little-endian at byte 18 (height may be negative for top-down).
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getInt32(18, true);
    const height = Math.abs(view.getInt32(22, true));
    if (width > 0 && height > 0) return { width, height };
  }
  // JPEG: scan segments for a Start-Of-Frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segLen <= 0) break;
      offset += 2 + segLen;
    }
  }
  return null;
}

/** Max embedded image width in px (~6.5in usable page width at 96dpi). */
const MAX_IMAGE_WIDTH = 600;

/** TipTap image node → a paragraph wrapping an ImageRun, or null if not embeddable. */
function imageParagraph(node: DocNode): Paragraph | null {
  const src = node.attrs?.src;
  if (!src || !src.startsWith('data:')) return null;

  const meta = src.slice(5, src.indexOf(','));
  const mime = meta.split(';')[0] ?? '';
  const type = imageTypeFromMime(mime);
  if (!type) return null;

  let bytes: Uint8Array;
  try {
    bytes = decodeDataUrlBytes(src);
  } catch {
    return null;
  }

  const intrinsic = imageDimensions(bytes) ?? { width: 400, height: 300 };
  let { width, height } = intrinsic;
  if (width > MAX_IMAGE_WIDTH) {
    height = Math.round(height * (MAX_IMAGE_WIDTH / width));
    width = MAX_IMAGE_WIDTH;
  }

  return new Paragraph({
    children: [new ImageRun({ data: bytes, type, transformation: { width, height } })],
  });
}

function tableCellToDocx(cell: DocNode): DocxTableCell {
  const blocks = blockNodesToDocx((cell.content as DocNode[] | undefined) ?? []);
  return new DocxTableCell({
    children: blocks.length > 0 ? blocks : [new Paragraph({ text: '' })],
  });
}

function tableToDocx(node: DocNode): DocxTable {
  const emptyCell = () => new DocxTableCell({ children: [new Paragraph({ text: '' })] });
  const rows = ((node.content as DocNode[] | undefined) ?? []).map((row) => {
    const cells = ((row.content as DocNode[] | undefined) ?? []).map(tableCellToDocx);
    return new DocxTableRow({ children: cells.length > 0 ? cells : [emptyCell()] });
  });
  return new DocxTable({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.length > 0 ? rows : [new DocxTableRow({ children: [emptyCell()] })],
  });
}

/** Convert a single TipTap block node into one or more docx blocks. */
function blockNodeToDocx(node: DocNode): DocxBlock[] {
  switch (node.type) {
    case 'heading': {
      const level = node.attrs?.level ?? 1;
      const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
      };
      return [new Paragraph({ text: nodeText(node), heading: headingMap[level] ?? HeadingLevel.HEADING_1 })];
    }
    case 'paragraph':
      return [new Paragraph({ children: inlineToRuns(node.content as InlineNode[] | undefined) })];
    case 'image': {
      const para = imageParagraph(node);
      return para ? [para] : [];
    }
    case 'bulletList':
    case 'orderedList': {
      const items: DocxBlock[] = [];
      for (const item of (node.content as DocNode[] | undefined) ?? []) {
        const para = (item.content as DocNode[] | undefined)?.[0];
        const text = para?.type === 'paragraph' ? nodeText(para) : nodeText(item);
        items.push(new Paragraph({ text: `• ${text}` }));
      }
      return items;
    }
    case 'table':
      return [tableToDocx(node)];
    case 'blockquote': {
      const text = nodeText(node);
      return [new Paragraph({ text: text ? `“${text}”` : '' })];
    }
    case 'codeBlock':
      return [new Paragraph({ children: [new TextRun({ text: nodeText(node), font: 'Courier New' })] })];
    case 'horizontalRule':
      return [new Paragraph({ text: '---' })];
    default: {
      const text = nodeText(node);
      return text ? [new Paragraph({ text })] : [];
    }
  }
}

function blockNodesToDocx(nodes: DocNode[]): DocxBlock[] {
  return nodes.flatMap(blockNodeToDocx);
}

/** TipTap JSON → simplified .docx bytes (round-trip is lossy). */
export async function serializeDocx(json: object): Promise<Uint8Array> {
  const doc = json as { content?: DocNode[] };
  const children = blockNodesToDocx(doc.content ?? []);

  const docx = new DocxDocument({
    sections: [
      {
        properties: {},
        children: children.length > 0 ? children : [new Paragraph({ text: '' })],
      },
    ],
  });

  // toArrayBuffer (not toBuffer): the webview has no Node `Buffer`, so the
  // JSZip "nodebuffer" path used by toBuffer throws there. "arraybuffer" works.
  const buffer = await Packer.toArrayBuffer(docx);
  return new Uint8Array(buffer);
}
