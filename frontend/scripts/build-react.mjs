import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await mkdir('dist/assets', { recursive: true });
await build({
  entryPoints: ['src/main.jsx', 'src/admin.jsx'], bundle: true, minify: true, format: 'esm',
  jsx: 'automatic', outdir: 'dist/assets', target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info',
});
await cp('public', 'dist', { recursive: true });
for (const [name, entry] of [['index.html', 'main'], ['rolling.html', 'main'], ['admin.html', 'admin']]) {
  const source = await readFile(name, 'utf8');
  const html = source.replace('/src/rolling.css', `/assets/${entry}.css`)
    .replace(`/src/${entry}.jsx`, `/assets/${entry}.js`);
  await writeFile(path.join('dist', name), html);
}
console.log('React production build complete: dist/');
