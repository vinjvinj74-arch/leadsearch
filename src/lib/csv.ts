export function protectCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",;\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(protectCsvCell).join(';')];
  for (const row of rows) {
    lines.push(headers.map((header) => protectCsvCell(row[header])).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
