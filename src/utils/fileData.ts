/** Convert raw bytes to a base64 string (chunked to avoid call-stack limits). */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Build a data URL from raw bytes and a MIME type. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${uint8ToBase64(bytes)}`;
}

/** Best-effort MIME type from a file name/path extension. */
export function mimeTypeFromPath(pathOrName: string): string {
  const ext = pathOrName.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

/** Decode a data URL payload to raw bytes (base64 or percent-encoded). */
export function decodeDataUrlBytes(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Invalid data URL.');
  }

  const firstComma = dataUrl.indexOf(',');
  if (firstComma === -1) {
    throw new Error('Invalid data URL.');
  }

  const metadata = dataUrl.slice(0, firstComma);
  const payload = dataUrl.slice(firstComma + 1);

  if (/;base64/i.test(metadata)) {
    const binary = atob(payload);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  return new TextEncoder().encode(decodeURIComponent(payload));
}

export function decodeDataUrlText(dataUrl: string): string {
  if (!dataUrl.startsWith('data:')) {
    return dataUrl;
  }

  const firstComma = dataUrl.indexOf(',');
  if (firstComma === -1) {
    throw new Error('Invalid data URL.');
  }

  const metadata = dataUrl.slice(0, firstComma);
  const payload = dataUrl.slice(firstComma + 1);

  if (/;base64/i.test(metadata)) {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return decodeURIComponent(payload);
}

export async function generateVideoThumbnailDataUrl(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('video/')) {
    return undefined;
  }

  return new Promise<string | undefined>((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    let awaitingSeek = false;

    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (result?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const capture = () => {
      if (!video.videoWidth || !video.videoHeight) {
        finish(undefined);
        return;
      }

      const scale = Math.min(1, 480 / video.videoWidth, 270 / video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

      const context = canvas.getContext('2d');
      if (!context) {
        finish(undefined);
        return;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', 0.82));
    };

    const timeoutId = window.setTimeout(() => finish(undefined), 5000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    video.addEventListener('error', () => finish(undefined), { once: true });
    video.addEventListener('seeked', () => {
      window.clearTimeout(timeoutId);
      capture();
    }, { once: true });
    video.addEventListener('loadeddata', () => {
      if (!awaitingSeek) {
        window.clearTimeout(timeoutId);
        capture();
      }
    }, { once: true });
    video.addEventListener('loadedmetadata', () => {
      const targetTime = Number.isFinite(video.duration) && video.duration > 0.1 ? 0.1 : 0;
      if (targetTime <= 0) {
        return;
      }

      awaitingSeek = true;
      try {
        video.currentTime = targetTime;
      } catch {
        awaitingSeek = false;
      }
    }, { once: true });

    video.src = objectUrl;
    video.load();
  });
}
