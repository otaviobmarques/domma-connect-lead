// Copia o motor de envio (../engine) para dentro do app antes de rodar ou empacotar
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'engine'), dst = path.join(here, '..', 'engine');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of ['engine.js', 'qr-driver.js']) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('Motor copiado para desktop/engine');
