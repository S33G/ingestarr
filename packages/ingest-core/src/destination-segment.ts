const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type DestinationPlatform = 'posix' | 'win32';

export function sanitizeDestinationSegment(
  value: string,
  platform: DestinationPlatform = 'win32',
): string {
  let sanitized = [...value.normalize('NFC')]
    .map((character) =>
      character === '/' ||
      character === '\0' ||
      (platform === 'win32' && (character.charCodeAt(0) <= 31 || /[<>:"\\|?*]/.test(character)))
        ? '_'
        : character,
    )
    .join('');
  if (platform === 'win32') sanitized = sanitized.replace(/[. ]+$/g, '');
  if (sanitized === '' || sanitized === '.' || sanitized === '..') sanitized = '_';
  if (platform === 'win32' && WINDOWS_RESERVED_NAME.test(sanitized)) sanitized = `_${sanitized}`;
  return sanitized;
}
