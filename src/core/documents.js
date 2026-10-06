'use strict';

// Generates the documents customers and parties attach to their emails (purchase
// orders, invoices, remittance advice, specifications, letters...). The AI describes
// a document as a small structured spec; this module renders it as a real PDF,
// Word or Excel file in the format of the scenario's year:
//   Word:  .docx from 2007, .doc before (RTF content, which Word opens as a .doc)
//   Excel: .xlsx from 2007, .xls (BIFF8) before
//   PDF:   any year
//
// spec = {
//   format: 'pdf' | 'word' | 'excel', filename, title, reference, date,
//   fields: { "Deliver to": "...", ... }, table: { columns: [...], rows: [[...]] },
//   totals: { "Subtotal": "£1,200.00", ... }, notes: "free text"
// }

const XLSX = require('xlsx');

const MODERN_OFFICE_YEAR = 2007;

function clean(spec) {
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const cols = Array.isArray(spec.table && spec.table.columns) ? spec.table.columns.map(str).slice(0, 8) : [];
  const rows = Array.isArray(spec.table && spec.table.rows)
    ? spec.table.rows.filter(Array.isArray).slice(0, 60).map((r) => r.slice(0, cols.length || 8).map(str))
    : [];
  const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o)
    ? Object.entries(o).slice(0, 12).map(([k, v]) => [str(k), str(v)]) : []);
  return {
    format: ['pdf', 'word', 'excel'].includes(spec.format) ? spec.format : 'pdf',
    title: str(spec.title || 'Document').slice(0, 120),
    reference: str(spec.reference).slice(0, 60),
    date: str(spec.date).slice(0, 40),
    fields: obj(spec.fields),
    table: { columns: cols, rows },
    totals: obj(spec.totals),
    notes: str(spec.notes).slice(0, 3000),
    filename: str(spec.filename),
  };
}

// Safe file name with the right extension for the era.
function fileName(spec, ext) {
  const base = (spec.filename || [spec.title, spec.reference].filter(Boolean).join(' '))
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Document';
  return `${base}.${ext}`;
}

// Plain-text rendering: stored on the message so the AI and the Conversations view
// can read what was sent.
function toText(s, org) {
  const out = [org.name, s.title.toUpperCase()];
  if (s.reference) out.push(`Reference: ${s.reference}`);
  if (s.date) out.push(`Date: ${s.date}`);
  for (const [k, v] of s.fields) out.push(`${k}: ${v}`);
  if (s.table.columns.length) {
    out.push('', s.table.columns.join('\t'));
    for (const r of s.table.rows) out.push(r.join('\t'));
  }
  if (s.totals.length) out.push('', ...s.totals.map(([k, v]) => `${k}: ${v}`));
  if (s.notes) out.push('', s.notes);
  return out.filter((l) => l !== undefined).join('\n').trim();
}

// ---------- PDF ----------

// The standard PDF fonts only cover WinAnsi; replace anything else.
const winAnsi = (t) => String(t)
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')
  .replace(/\u2026/g, '...').replace(/[^\x20-\x7E\xA0-\xFF€£]/g, '');

async function pdf(s, org) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(s.title);
  doc.setAuthor(org.person || org.name);
  doc.setProducer(org.year && org.year < 2010 ? 'Acrobat Distiller 6.0 (Windows)' : 'Microsoft® Word for Microsoft 365');
  doc.setCreationDate(org.now);
  doc.setModificationDate(org.now);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28; const H = 841.89; const M = 50;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const text = (t, x, size = 10, f = font, color = rgb(0, 0, 0)) => page.drawText(winAnsi(t), { x, y, size, font: f, color });
  const wrap = (t, width, size, f = font) => {
    const words = winAnsi(t).split(/\s+/); const lines = []; let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const need = (h) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };

  // Letterhead
  text(org.name, M, 16, bold, rgb(0.1, 0.2, 0.45)); y -= 16;
  if (org.email) { text(org.email, M, 9, font, rgb(0.35, 0.35, 0.35)); y -= 12; }
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: rgb(0.1, 0.2, 0.45) });
  y -= 28;
  text(s.title.toUpperCase(), M, 14, bold); y -= 20;
  const meta = [s.reference && ['Reference', s.reference], s.date && ['Date', s.date], ...s.fields].filter(Boolean);
  for (const [k, v] of meta) {
    for (const [i, l] of wrap(v, W - 2 * M - 120, 10).entries()) {
      need(14);
      if (i === 0) text(`${k}:`, M, 10, bold);
      text(l, M + 120, 10); y -= 14;
    }
  }
  y -= 10;

  if (s.table.columns.length) {
    const n = s.table.columns.length;
    const first = Math.min(0.45, 1.6 / n);
    const widths = s.table.columns.map((_, i) => (W - 2 * M) * (i === 0 ? first : (1 - first) / (n - 1 || 1)));
    const row = (cells, f, shade) => {
      const wrapped = cells.map((c, i) => wrap(c, widths[i] - 8, 9, f));
      const h = Math.max(...wrapped.map((l) => l.length)) * 12 + 6;
      need(h);
      if (shade) page.drawRectangle({ x: M, y: y - h + 9, width: W - 2 * M, height: h, color: rgb(0.9, 0.92, 0.96) });
      let x = M;
      wrapped.forEach((lines, i) => {
        lines.forEach((l, j) => page.drawText(l, { x: x + 4, y: y - j * 12, size: 9, font: f }));
        x += widths[i];
      });
      y -= h;
      page.drawLine({ start: { x: M, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
    };
    row(s.table.columns, bold, true);
    for (const r of s.table.rows) row(r, font, false);
    y -= 8;
  }
  for (const [k, v] of s.totals) {
    need(14);
    text(`${k}:`, W - M - 200, 10, bold); text(v, W - M - 80, 10, k.toLowerCase().includes('total') ? bold : font); y -= 14;
  }
  if (s.notes) {
    y -= 10;
    for (const para of s.notes.split('\n')) {
      for (const l of wrap(para || ' ', W - 2 * M, 10)) { need(14); text(l, M, 10); y -= 14; }
    }
  }
  return Buffer.from(await doc.save());
}

// ---------- Word ----------

async function docx(s, org) {
  const d = require('docx');
  const p = (t, opts = {}) => new d.Paragraph({ children: [new d.TextRun({ text: t, ...opts })] });
  const children = [
    p(org.name, { bold: true, size: 32, color: '1F3864' }),
    ...(org.email ? [p(org.email, { size: 18, color: '595959' })] : []),
    p(''),
    p(s.title.toUpperCase(), { bold: true, size: 28 }),
    ...[s.reference && ['Reference', s.reference], s.date && ['Date', s.date], ...s.fields].filter(Boolean)
      .map(([k, v]) => new d.Paragraph({ children: [new d.TextRun({ text: `${k}: `, bold: true }), new d.TextRun(v)] })),
    p(''),
  ];
  if (s.table.columns.length) {
    const cell = (t, b) => new d.TableCell({ children: [p(t, { bold: b })] });
    children.push(new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      rows: [
        new d.TableRow({ tableHeader: true, children: s.table.columns.map((c) => cell(c, true)) }),
        ...s.table.rows.map((r) => new d.TableRow({ children: s.table.columns.map((_, i) => cell(r[i] || '', false)) })),
      ],
    }), p(''));
  }
  for (const [k, v] of s.totals) {
    children.push(new d.Paragraph({ alignment: d.AlignmentType.RIGHT, children: [new d.TextRun({ text: `${k}: `, bold: true }), new d.TextRun(v)] }));
  }
  if (s.notes) children.push(p(''), ...s.notes.split('\n').map((l) => p(l)));
  const doc = new d.Document({ creator: org.person || org.name, title: s.title, sections: [{ children }] });
  return d.Packer.toBuffer(doc);
}

// Pre-2007 Word documents: RTF, which Word (and LibreOffice) open as a normal .doc.
function rtfDoc(s, org) {
  const e = (t) => String(t).replace(/[\\{}]/g, (c) => '\\' + c)
    .replace(/[^\x00-\x7F]/g, (c) => { const n = c.charCodeAt(0); return n < 256 ? `\\'${n.toString(16).padStart(2, '0')}` : `\\u${n > 32767 ? n - 65536 : n}?`; })
    .replace(/\n/g, '\\par\n');
  const out = ['{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}{\\colortbl;\\red31\\green56\\blue100;}',
    `{\\info{\\title ${e(s.title)}}{\\author ${e(org.person || org.name)}}}`, '\\f0\\fs20',
    `{\\cf1\\b\\fs32 ${e(org.name)}}\\par`, org.email ? `{\\fs18 ${e(org.email)}}\\par` : '', '\\par',
    `{\\b\\fs28 ${e(s.title.toUpperCase())}}\\par`];
  for (const [k, v] of [s.reference && ['Reference', s.reference], s.date && ['Date', s.date], ...s.fields].filter(Boolean)) {
    out.push(`{\\b ${e(k)}:} ${e(v)}\\par`);
  }
  out.push('\\par');
  if (s.table.columns.length) {
    const n = s.table.columns.length; const w = Math.floor(9000 / n);
    const rowDef = `\\trowd\\trgaph108${s.table.columns.map((_, i) => `\\clbrdrt\\brdrs\\clbrdrb\\brdrs\\clbrdrl\\brdrs\\clbrdrr\\brdrs\\cellx${w * (i + 1)}`).join('')}`;
    out.push(`${rowDef}${s.table.columns.map((c) => `\\pard\\intbl{\\b ${e(c)}}\\cell`).join('')}\\row`);
    for (const r of s.table.rows) out.push(`${rowDef}${s.table.columns.map((_, i) => `\\pard\\intbl ${e(r[i] || '')}\\cell`).join('')}\\row`);
    out.push('\\pard\\par');
  }
  for (const [k, v] of s.totals) out.push(`\\qr{\\b ${e(k)}:} ${e(v)}\\par\\ql`);
  if (s.notes) out.push('\\par', `${e(s.notes)}\\par`);
  out.push('}');
  return Buffer.from(out.join('\n'), 'latin1');
}

// ---------- Excel ----------

function spreadsheet(s, org, bookType) {
  const num = (v) => { const n = Number(String(v).replace(/[£$€,\s]/g, '')); return /^[£$€]?-?[\d,]+(\.\d+)?$/.test(String(v).trim()) && !Number.isNaN(n) ? n : v; };
  const aoa = [[org.name], [s.title], ...(s.reference ? [['Reference', s.reference]] : []), ...(s.date ? [['Date', s.date]] : []),
    ...s.fields, []];
  if (s.table.columns.length) aoa.push(s.table.columns, ...s.table.rows.map((r) => r.map(num)), []);
  aoa.push(...s.totals);
  if (s.notes) aoa.push([], [s.notes]);
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: s.title, Author: org.person || org.name, CreatedDate: org.now };
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = (s.table.columns.length ? s.table.columns : ['', '']).map((_, i) => ({ wch: i === 0 ? 34 : 14 }));
  XLSX.utils.book_append_sheet(wb, ws, (s.title || 'Sheet1').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

/**
 * Render a spec. org = { name, email, person, year, now }.
 * Returns { filename, content, contentType, record } where record is the attachment
 * entry stored on the sent message (text + the spec, so it can be re-generated later).
 */
async function generate(rawSpec, org) {
  const s = clean(rawSpec || {});
  const modern = !org.year || org.year >= MODERN_OFFICE_YEAR;
  let ext; let contentType; let content;
  if (s.format === 'word') {
    if (modern) { ext = 'docx'; contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; content = await docx(s, org); }
    else { ext = 'doc'; contentType = 'application/msword'; content = rtfDoc(s, org); }
  } else if (s.format === 'excel') {
    if (modern) { ext = 'xlsx'; contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; content = spreadsheet(s, org, 'xlsx'); }
    else { ext = 'xls'; contentType = 'application/vnd.ms-excel'; content = spreadsheet(s, org, 'biff8'); }
  } else {
    ext = 'pdf'; contentType = 'application/pdf'; content = await pdf(s, org);
  }
  const filename = fileName(s, ext);
  return {
    filename,
    content,
    contentType,
    record: { filename, contentType, size: content.length, kind: ext, status: 'ok', text: toText(s, org), truncated: false, spec: rawSpec, sent: true },
  };
}

module.exports = { generate, clean, toText };
