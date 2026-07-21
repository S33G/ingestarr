import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

await rm(path.join(tmpdir(), 'ingestarr-desktop-runtime'), {
  recursive: true,
  force: true,
});
await rm(path.join(tmpdir(), 'Ingestarr Third-Party Notices'), {
  recursive: true,
  force: true,
});
