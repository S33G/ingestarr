import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const productName = 'Ingestarr';

export async function packagedPaths() {
  const output = path.join(
    desktopRoot,
    'out',
    `${productName}-${process.platform}-${process.arch}`,
  );
  let executable;
  let resources;
  if (process.platform === 'darwin') {
    const application = path.join(output, `${productName}.app`, 'Contents');
    executable = path.join(application, 'MacOS', productName);
    resources = path.join(application, 'Resources');
  } else {
    executable = path.join(
      output,
      process.platform === 'win32' ? `${productName}.exe` : productName,
    );
    resources = path.join(output, 'resources');
  }
  await access(executable);
  await access(resources);
  return { desktopRoot, executable, resources };
}
