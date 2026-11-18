// Wrangler empacota o Worker com a condição "browser". O iconv-lite (usado pelo
// body-parser do Express) declara "./lib/streams": false nessa condição, o que
// gera `require_streams(...) is not a function` no runtime do Workers.
// Remover o campo "browser" faz o bundle resolver as versões Node dos módulos.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_DEPTH = 5;

async function walk(dir, depth) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const full = join(dir, entry.name);
    if (entry.name === 'iconv-lite') {
      const file = join(full, 'package.json');
      try {
        const json = JSON.parse(await readFile(file, 'utf8'));
        if (json.browser) {
          delete json.browser;
          await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
          console.log(`[patch-iconv-lite] patched ${file}`);
        }
      } catch {
        // Pacote ausente ou inválido: nada a fazer.
      }
      continue;
    }
    if (depth < MAX_DEPTH) await walk(full, depth + 1);
  }
}

await walk(join(process.cwd(), 'node_modules'), 0);
