export type FileCategory = 'image' | 'video' | 'text' | 'code' | 'pdf' | 'other';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'doc']);
const CODE_EXTENSIONS = new Set(['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'json', 'html', 'htm', 'css', 'scss', 'yaml', 'yml', 'toml', 'xml', 'csv', 'env', 'local', 'gitignore', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'hpp']);
const PDF_EXTENSIONS = new Set(['pdf']);
/** Office Open XML Word — binary; opened via mammoth, not as plain text. */
const DOCX_EXTENSIONS = new Set(['docx']);

const ALL_TEXT_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...CODE_EXTENSIONS]);
const MIME_CATEGORY_MAP = new Map<string, FileCategory>([
  ['application/json', 'code'],
  ['application/ld+json', 'code'],
  ['application/javascript', 'code'],
  ['application/typescript', 'code'],
  ['application/xml', 'code'],
  ['application/yaml', 'code'],
  ['application/x-yaml', 'code'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['text/csv', 'text'],
  ['text/tab-separated-values', 'text'],
]);
const MIME_EXTENSION_MAP = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
  ['image/bmp', 'bmp'],
  ['image/x-icon', 'ico'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/ogg', 'ogv'],
  ['video/quicktime', 'mov'],
  ['video/x-matroska', 'mkv'],
  ['video/x-msvideo', 'avi'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['text/csv', 'csv'],
  ['application/json', 'json'],
  ['application/pdf', 'pdf'],
]);

function normalizeMimeType(mimeType?: string): string {
  return mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function getFileExtension(name: string): string {
  const parts = name.split('.');
  if (parts.length < 2) return '';
  return parts.pop()?.toLowerCase() ?? '';
}

export function getFileCategoryFromMimeType(mimeType?: string): FileCategory | null {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (!normalizedMimeType) return null;

  const mappedCategory = MIME_CATEGORY_MAP.get(normalizedMimeType);
  if (mappedCategory) return mappedCategory;

  if (normalizedMimeType.startsWith('image/')) return 'image';
  if (normalizedMimeType.startsWith('video/')) return 'video';
  if (normalizedMimeType.startsWith('text/')) return 'code';

  return null;
}

export function getFileCategory(name: string, mimeType?: string): FileCategory {
  const mimeTypeCategory = getFileCategoryFromMimeType(mimeType);
  if (mimeTypeCategory) return mimeTypeCategory;

  const ext = getFileExtension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'other';
}

export function isTextFile(name: string): boolean {
  const ext = getFileExtension(name);
  return ALL_TEXT_EXTENSIONS.has(ext);
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(name));
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(getFileExtension(name));
}

export function isPdfFile(name: string): boolean {
  return PDF_EXTENSIONS.has(getFileExtension(name));
}

export function isDocxFile(name: string): boolean {
  return DOCX_EXTENSIONS.has(getFileExtension(name));
}

/** Returns true if the file can be opened in TipTap editor (text/code + images + docx) */
export function canOpenInTipTap(name: string): boolean {
  return isTextFile(name) || isImageFile(name) || isDocxFile(name);
}

export function inferMimeTypeFromDataUrl(dataUrl?: string): string | undefined {
  if (!dataUrl?.startsWith('data:')) return undefined;
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1]?.toLowerCase();
}

export function synthesizeAttachmentName(name?: string, mimeType?: string): string {
  if (name?.trim()) return name;

  const normalizedMimeType = normalizeMimeType(mimeType);
  const mappedExtension = MIME_EXTENSION_MAP.get(normalizedMimeType);
  if (mappedExtension) return `attachment.${mappedExtension}`;

  const category = getFileCategoryFromMimeType(normalizedMimeType);
  switch (category) {
    case 'image':
      return 'attachment.png';
    case 'video':
      return 'attachment.mp4';
    case 'pdf':
      return 'attachment.pdf';
    case 'text':
    case 'code':
      return 'attachment.txt';
    default:
      return 'attachment';
  }
}
