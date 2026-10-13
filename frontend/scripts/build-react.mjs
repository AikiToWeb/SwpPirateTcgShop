import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await mkdir('dist/assets', { recursive: true });
await build({
  entryPoints: ['src/main.jsx'], bundle: true, minify: true, format: 'esm',
  jsx: 'automatic', outdir: 'dist/assets', target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info',
});
await cp('public', 'dist', { recursive: true });
for (const name of ['index.html', 'rolling.html']) {
  const source = await readFile(name, 'utf8');
  await writeFile(path.join('dist', name), source.replace('/src/rolling.css', '/assets/main.css').replace('/src/main.jsx', '/assets/main.js'));
}
console.log('React production build complete: dist/');
