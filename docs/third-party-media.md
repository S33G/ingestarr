# Thumbnail pipeline dependencies

Versions are locked by `pnpm-lock.yaml`; package provenance was checked from the installed package metadata on 2026-07-19.

## Sharp

- Package: `sharp` 0.35.3
- Source: https://github.com/lovell/sharp
- Documentation: https://sharp.pixelplumbing.com
- License: Apache-2.0
- Bundled platform packages: `@img/sharp-*` 0.35.3 and `@img/sharp-libvips-*` 1.3.2. Their license files must remain in packaged notices.
- Purpose: bounded image decoding, EXIF auto-orientation, resize-inside transforms, metadata-free WebP/JPEG encoding, and output inspection.

## FFmpeg

- Package: `ffmpeg-static` 5.3.0
- Package source: https://github.com/eugeneware/ffmpeg-static
- Binary release: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- Packaged provenance: the generated notice records the declared release tag, executable self-report, and SHA-256; the native smoke recomputes the hash. The current macOS Apple Silicon asset self-reports FFmpeg 6.0 even though package metadata declares release `b6.1.1`, so the hash and release URL are retained rather than inferring identity from the version banner.
- Package and downloaded binary license declaration: GPL-3.0-or-later
- Upstream binary provenance documented by the package:
  - Windows: https://www.gyan.dev/ffmpeg/builds/ and https://github.com/sudo-nautilus/FFmpeg-Builds-Win32/
  - Linux: https://johnvansickle.com/ffmpeg/
  - macOS Intel: https://evermeet.cx/pub/ffmpeg/
  - macOS Apple Silicon: https://osxexperts.net/
- Purpose: deterministic video poster extraction through the exact package-exported executable path.

The GPL dependency is a distribution concern, not only an attribution item. Unsigned, internal, test, and CI-produced binaries are not exempt merely because they are unsigned or short-lived.

**Milestone 4 distribution blocker:** CI artifacts containing `ffmpeg-static` must not be distributed until corresponding-source/source-offer compliance and required notices are automated and verified, or `ffmpeg-static` is replaced by an approved LGPL-compatible FFmpeg build. Preserve the exact-path/no-shell execution boundary if the binary provider changes.

Packaged applications include `FFmpeg-GPL-3.0-or-later.txt`, `FFmpeg-BUILD-LICENSE-NOTICE.txt`, `FFmpeg-BINARY-README.txt`, and `FFmpeg-NOTICE.txt` under `Ingestarr Third-Party Notices` in the Electron resources directory. The notice records package and binary provenance URLs; this packaging does not by itself satisfy corresponding-source obligations.

## ExifTool

- Existing package: `exiftool-vendored`
- Source: https://github.com/photostructure/exiftool-vendored.js
- Purpose in this milestone: extract embedded RAW previews in the explicit order `PreviewImage`, `JpgFromRaw`, then `ThumbnailImage`; originals are read-only.
