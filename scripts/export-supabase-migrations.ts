import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrations } from '../src/db/migrations.js';

const outputDir = path.join(process.cwd(), 'supabase', 'migrations');
await mkdir(outputDir, { recursive: true });

for (const migration of migrations) {
  const version = `2026010100000${migration.version}`;
  const filename = path.join(outputDir, `${version}_${migration.name}.sql`);
  await writeFile(filename, `${migration.sql.trim()}\n`, 'utf8');
  console.log(`Escrito ${path.relative(process.cwd(), filename)}`);
}
