import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(distDir, 'index.html'));
console.log('Build completed successfully: dist/index.html generated.');
