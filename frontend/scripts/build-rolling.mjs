import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'rolling-dist');
await mkdir(path.join(output, 'src'), { recursive: true });
const html = await readFile(path.join(root, 'rolling.html'), 'utf8');
await writeFile(path.join(output, 'index.html'), html);
await writeFile(path.join(output, 'rolling.html'), html);
await copyFile(path.join(root, 'src/rolling.js'), path.join(output, 'src/rolling.js'));
await copyFile(path.join(root, 'src/rolling.css'), path.join(output, 'src/rolling.css'));
await cp(path.join(root, 'public/rolling-assets'), path.join(output, 'rolling-assets'), { recursive: true });
await mkdir(path.join(output, 'swp-assets'), { recursive: true });
await copyFile(path.join(root, 'public/swp-assets/swp-shop-banner.png'), path.join(output, 'swp-assets/swp-shop-banner.png'));
console.log('Rolling Dice static mockup built: rolling-dist/index.html');
