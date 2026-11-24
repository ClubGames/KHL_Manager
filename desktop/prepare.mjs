// Copies the web build (../dist, `npm run build` in the repository root) into the app and the icon into build/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '../dist');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error('Нет ../dist/index.html — сначала соберите игру: npm run build (в корне репозитория).');
  process.exit(1);
}
fs.rmSync(path.join(here, 'app'), { recursive: true, force: true });
fs.cpSync(web, path.join(here, 'app'), { recursive: true });
fs.mkdirSync(path.join(here, 'build'), { recursive: true });
fs.copyFileSync(path.resolve(here, '../public/icon-512.png'), path.join(here, 'build/icon.png'));
console.log('web build copied to desktop/app');
