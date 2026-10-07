import { access, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../src/', import.meta.url);
const output = new URL('../dist/', import.meta.url);

// Validate the source before replacing generated output.
for (const file of ['index.html', 'styles.css', 'app.js', 'assets/fonts']) {
  await access(new URL(file, source));
}

await mkdir(output, { recursive: true });
for (const entry of await readdir(output)) {
  await rm(new URL(entry, output), { recursive: true, force: true });
}
await cp(source, output, { recursive: true });
console.log(`Built landing page: ${fileURLToPath(output)}`);
