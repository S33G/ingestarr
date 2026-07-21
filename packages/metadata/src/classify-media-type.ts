export type MediaType = 'photo' | 'video' | 'unknown';

const PHOTO_EXTENSIONS = new Set([
  '.3fr',
  '.arw',
  '.avif',
  '.cr2',
  '.cr3',
  '.dng',
  '.erf',
  '.fff',
  '.heic',
  '.heif',
  '.iiq',
  '.jpeg',
  '.jpg',
  '.jxl',
  '.kdc',
  '.mef',
  '.mos',
  '.mrw',
  '.nef',
  '.nrw',
  '.orf',
  '.pef',
  '.png',
  '.raf',
  '.raw',
  '.rw2',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
  '.tif',
  '.tiff',
  '.webp',
  '.x3f',
]);

const VIDEO_EXTENSIONS = new Set([
  '.3gp',
  '.avi',
  '.insv',
  '.lrv',
  '.m2t',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.r3d',
  '.webm',
]);

function fromMime(mimeType: string | null | undefined): MediaType {
  const normalized = mimeType?.trim().toLowerCase();
  if (normalized?.startsWith('image/') === true) return 'photo';
  if (normalized?.startsWith('video/') === true) return 'video';
  return 'unknown';
}

function fromExtension(extension: string): MediaType {
  const normalized = `${extension.startsWith('.') ? '' : '.'}${extension}`.toLowerCase();
  if (PHOTO_EXTENSIONS.has(normalized)) return 'photo';
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video';
  return 'unknown';
}

/**
 * MIME is content-derived and wins when recognized. A known extension is the
 * deterministic fallback for missing or generic MIME values.
 */
export function classifyMediaType(input: {
  extension: string;
  mimeType?: string | null;
}): MediaType {
  const mime = fromMime(input.mimeType);
  return mime === 'unknown' ? fromExtension(input.extension) : mime;
}
