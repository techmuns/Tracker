// csv.js — minimal RFC-4180 CSV parser (handles quoted fields with commas and
// newlines, and "" escaped quotes). Returns an array of rows (arrays of cells).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore, handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  // flush trailing field/row if file doesn't end in newline
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
