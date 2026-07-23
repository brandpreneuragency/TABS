import { getExt, writeBinaryFile, writeTextFile } from './fs-adapter';
import { serialize } from './fileFormat';
import { serializeDocx } from './docxFormat';

/**
 * Persist TipTap editor JSON to disk, choosing text vs binary by extension.
 * .docx uses a lossy round-trip via the `docx` package (not original OOXML).
 */
export async function writeEditorContent(path: string, editorJson: object): Promise<void> {
  const ext = getExt(path) || 'md';
  if (ext === 'docx') {
    const bytes = await serializeDocx(editorJson);
    await writeBinaryFile(path, bytes);
    return;
  }
  await writeTextFile(path, serialize(editorJson, ext));
}
