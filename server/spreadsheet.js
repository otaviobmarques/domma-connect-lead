import * as XLSX from 'xlsx';
import { normalizePhone } from './phone.js';

export function slugify(label) {
  return String(label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'coluna';
}

const PHONE_HINT = /(whats|zap|cel|fone|telefone|phone|tel\b|tel_|contato|numero|n_mero|mobile)/;
const NAME_HINT = /(^nome|nome_|cliente|^name|razao|responsavel|contato_nome|primeiro_nome)/;

/** Lê xlsx/xls/csv e devolve colunas + linhas (valores como texto). */
export function parseSpreadsheet(buffer, filename = '') {
  const isCsv = /\.(csv|txt)$/i.test(filename);
  const wb = isCsv
    ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: false })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Planilha vazia');
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  const headerIdx = matrix.findIndex(r => r.filter(c => String(c).trim()).length >= 1);
  if (headerIdx < 0) throw new Error('Planilha vazia');

  const header = matrix[headerIdx].map(c => String(c).trim());
  // Se a "linha de cabeçalho" já parece telefone, não há cabeçalho
  const headerLooksLikeData = header.some(h => normalizePhone(h).ok);
  const labels = headerLooksLikeData ? header.map((_, i) => `Coluna ${i + 1}`) : header.map((h, i) => h || `Coluna ${i + 1}`);
  const used = new Set();
  const columns = labels.map(label => {
    let key = slugify(label), k = key, n = 2;
    while (used.has(k)) k = `${key}_${n++}`;
    used.add(k);
    return { key: k, label };
  });

  const dataRows = matrix.slice(headerLooksLikeData ? headerIdx : headerIdx + 1);
  const rows = dataRows
    .map(r => Object.fromEntries(columns.map((c, i) => [c.key, String(r[i] ?? '').trim()])))
    .filter(r => Object.values(r).some(v => v));

  return { columns, rows, ...detectColumns(columns, rows) };
}

export function detectColumns(columns, rows) {
  const sample = rows.slice(0, 50);
  let phoneColumn = null, best = 0;
  for (const c of columns) {
    const ok = sample.filter(r => normalizePhone(r[c.key]).ok).length;
    const score = ok / Math.max(sample.length, 1) + (PHONE_HINT.test(c.key) ? 0.5 : 0);
    if (score > best && (ok > 0 || PHONE_HINT.test(c.key))) { best = score; phoneColumn = c.key; }
  }
  let nameColumn = columns.find(c => NAME_HINT.test(c.key) && c.key !== phoneColumn)?.key || null;
  if (!nameColumn) {
    // primeira coluna com texto não-numérico
    nameColumn = columns.find(c => c.key !== phoneColumn &&
      sample.filter(r => /[a-zA-ZÀ-ú]{2,}/.test(r[c.key]) && !/@/.test(r[c.key])).length > sample.length * 0.6)?.key || null;
  }
  return { phoneColumn, nameColumn };
}

export function firstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

export function toXlsxBuffer(rows, sheetName = 'Relatório') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
