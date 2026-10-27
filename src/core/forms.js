'use strict';

// Forms the company sends to customers and parties (account applications, credit forms,
// order forms...): finds the blanks, and fills them in so the form can be sent back.
// Runs inside the extraction worker, since the files come from outside.
//
//   PDF   fillable form fields (text, check boxes, drop-downs, radio buttons)
//   Word  .docx content controls, "Label: ______" lines and empty cells next to a label
//   Excel .xlsx / .xls: an empty cell to the right of a label
//
// detect(kind, buf) -> [{ id, label, type: 'text' | 'check' | 'choice', options? }]
// fill(kind, buf, answers) -> Buffer, answers = { [id]: value }
// The same scan finds the same blanks in the same order, so ids stay valid between the two.

const MAX_FIELDS = 80;
const YES = /^(y|yes|true|x|✓|✔|on|1|checked|ticked|agree|agreed)$/i;

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim().slice(0, 100);

// ---------- PDF ----------

async function pdfForm(buf) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  return { doc, fields: doc.getForm().getFields().slice(0, MAX_FIELDS) };
}

function pdfLabel(field) {
  const { PDFName, PDFString, PDFHexString } = require('pdf-lib');
  const tu = field.acroField.dict.get(PDFName.of('TU'));
  if (tu instanceof PDFString || tu instanceof PDFHexString) return tidy(tu.decodeText());
  // "topmostSubform[0].Page1[0].CompanyName[0]" -> "Company Name"
  const last = field.getName().split('.').pop().replace(/\[\d+\]$/, '');
  return tidy(last.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

function pdfType(field) {
  const name = field.constructor.name;
  if (name === 'PDFCheckBox') return { type: 'check' };
  if (name === 'PDFDropdown' || name === 'PDFOptionList' || name === 'PDFRadioGroup') return { type: 'choice', options: field.getOptions().slice(0, 30) };
  if (name === 'PDFTextField') return { type: 'text' };
  return null; // buttons and signatures
}

async function detectPdf(buf) {
  const { fields } = await pdfForm(buf);
  const out = [];
  fields.forEach((f, i) => {
    const t = pdfType(f);
    if (t && !(f.isReadOnly && f.isReadOnly())) out.push({ id: `f${i + 1}`, label: pdfLabel(f) || `Field ${i + 1}`, ...t });
  });
  return out;
}

// Standard PDF fonts only cover Windows-1252, so swap anything else for something close.
const winAnsi = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff€\n]/g, '');

async function fillPdf(buf, answers) {
  const { doc, fields } = await pdfForm(buf);
  fields.forEach((f, i) => {
    const v = answers[`f${i + 1}`];
    if (v === undefined || v === null || v === '') return;
    const type = f.constructor.name;
    try {
      if (type === 'PDFTextField') {
        let text = winAnsi(v);
        const max = f.getMaxLength();
        if (max) text = text.slice(0, max);
        f.setText(text);
      } else if (type === 'PDFCheckBox') {
        if (YES.test(String(v).trim())) f.check(); else f.uncheck();
      } else if (type === 'PDFDropdown' || type === 'PDFOptionList' || type === 'PDFRadioGroup') {
        const opt = f.getOptions().find((o) => o.toLowerCase() === String(v).trim().toLowerCase());
        if (opt) f.select(opt);
      }
    } catch { /* one awkward field shouldn't stop the rest */ }
  });
  return Buffer.from(await doc.save());
}

// ---------- Word (.docx) ----------

const BLANK = /_{3,}|\.{5,}|…{2,}/;
const runsText = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => xmlUnesc(m[1])).join('');
const run = (v) => `<w:r><w:t xml:space="preserve">${xmlEsc(v)}</w:t></w:r>`;

// The nearest text before a position: "Company name:" in the cell or line before a box.
function textBefore(xml, pos) {
  const paras = xml.slice(Math.max(0, pos - 6000), pos).split(/<\/w:p>/).map(runsText).map((t) => t.trim()).filter(Boolean);
  return paras.length ? paras[paras.length - 1].slice(-80) : '';
}

// Every blank in document.xml, in document order, each with the edit that fills it.
function docxBlanks(xml) {
  const found = [];
  const covered = []; // regions already claimed by a content control or cell
  const overlaps = (a, b) => covered.some(([x, y]) => a < y && b > x);

  // 1. Content controls (Word's "click or tap here to enter text" boxes and tick boxes).
  for (const m of xml.matchAll(/<w:sdt>([\s\S]*?)<\/w:sdt>/g)) {
    const body = m[1];
    if (body.includes('<w:sdt>')) continue; // nested: leave alone
    const pr = (body.match(/<w:sdtPr>([\s\S]*?)<\/w:sdtPr>/) || [])[1] || '';
    const content = body.match(/<w:sdtContent>([\s\S]*?)<\/w:sdtContent>/);
    if (!content || /<w:(picture|docPartObj|date)\b/.test(pr)) continue;
    const name = (pr.match(/<w:alias w:val="([^"]*)"/) || pr.match(/<w:tag w:val="([^"]*)"/) || [])[1];
    const check = /<w14:checkbox>/.test(pr);
    const start = m.index;
    covered.push([start, start + m[0].length]);
    found.push({ start, end: start + m[0].length, label: name ? xmlUnesc(name) : textBefore(xml, start), type: check ? 'check' : 'text',
      apply: (v) => {
        if (check) {
          const on = YES.test(String(v).trim());
          return m[0].replace(/(<w14:checked w14:val=")[^"]*"/, `$1${on ? 1 : 0}"`).replace(on ? /☐/ : /☒/, on ? '☒' : '☐');
        }
        let first = true;
        const filled = content[1].replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (all, open, text, close) => {
          if (!first) return `${open}${close}`;
          first = false;
          return `<w:t xml:space="preserve">${xmlEsc(v)}${close}`;
        });
        const body2 = first ? content[1].replace(/<\/w:p>/, `${run(v)}</w:p>`) : filled;
        return m[0].replace(content[1], body2).replace(/<w:showingPlcHdr\/>/, '').replace(/<w:rStyle w:val="PlaceholderText"\/>/g, '');
      } });
  }

  // 2. Empty table cells next to a label cell ("Company name | ").
  for (const row of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
    if (overlaps(row.index, row.index + row[0].length) || row[0].includes('<w:tbl')) continue;
    const cells = [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
    cells.forEach((c, k) => {
      if (k === 0 || c[0].includes('<w:sdt') || runsText(c[0]).trim()) return;
      const label = runsText(cells[k - 1][0]).trim();
      if (!label || BLANK.test(label) || label.length > 80) return;
      const start = row.index + c.index;
      covered.push([start, start + c[0].length]);
      found.push({ start, end: start + c[0].length, label, type: 'text',
        apply: (v) => (/<w:p\b[^>]*\/>/.test(c[0]) && !/<\/w:p>/.test(c[0])
          ? c[0].replace(/<w:p\b([^>]*)\/>/, `<w:p$1>${run(v)}</w:p>`)
          : c[0].replace(/<\/w:p>/, `${run(v)}</w:p>`)) });
    });
  }

  // 3. "Label: ________" lines (underscores, dot leaders), anywhere else.
  let lastText = '';
  for (const p of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const text = runsText(p[0]);
    if (overlaps(p.index, p.index + p[0].length)) { if (text.trim()) lastText = text; continue; }
    const blank = text.match(BLANK);
    if (!blank) { if (text.trim()) lastText = text; continue; }
    const label = text.slice(0, blank.index).trim() || lastText.trim();
    if (label && label.length <= 80) {
      found.push({ start: p.index, end: p.index + p[0].length, label, type: 'text',
        apply: (v) => {
          let done = false;
          return p[0].replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (all, open, raw, close) => {
            const t = xmlUnesc(raw);
            if (!done && BLANK.test(t)) {
              done = true;
              return `<w:t xml:space="preserve">${xmlEsc(t.replace(BLANK, v))}${close}`;
            }
            // Leaders split across several runs: drop the leftovers.
            return done && /^[_.…\s]+$/.test(t) && t.trim() ? `${open}${close}` : all;
          });
        } });
    }
    lastText = text;
  }

  return found.sort((a, b) => a.start - b.start).slice(0, MAX_FIELDS)
    .map((f, i) => ({ ...f, id: `f${i + 1}`, label: tidy(f.label) || `Field ${i + 1}` }));
}

async function docxDocument(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('not a Word document');
  return { zip, xml: await file.async('string') };
}

async function detectDocx(buf) {
  const { xml } = await docxDocument(buf);
  return docxBlanks(xml).map(({ id, label, type }) => ({ id, label, type }));
}

async function fillDocx(buf, answers) {
  const { zip, xml } = await docxDocument(buf);
  let out = xml;
  // Later edits first, so earlier offsets stay valid.
  for (const f of docxBlanks(xml).reverse()) {
    const v = answers[f.id];
    if (v === undefined || v === null || v === '') continue;
    out = out.slice(0, f.start) + f.apply(String(v)) + out.slice(f.end);
  }
  zip.file('word/document.xml', out);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- Excel (.xlsx, .xls) ----------

// A text cell whose right-hand neighbour is empty, on a row that isn't a table row.
function sheetBlanks(wb) {
  const XLSX = require('xlsx');
  const out = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    let title = true; // the first row with anything in it is usually the form's title
    for (let r = range.s.r; r <= range.e.r; r++) {
      const filled = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v !== undefined && String(cell.v).trim() !== '') filled.push(c);
      }
      if (!filled.length) continue;
      const isTitle = title;
      title = false;
      if (filled.length > 4) continue;
      for (const c of filled) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const right = ws[XLSX.utils.encode_cell({ r, c: c + 1 })];
        if (cell.t !== 's' || (right && right.v !== undefined && String(right.v).trim() !== '')) continue;
        const label = String(cell.v).trim();
        if (label.length > 80 || /^\d/.test(label) || (isTitle && !label.endsWith(':'))) continue;
        out.push({ sheet: name, ref: XLSX.utils.encode_cell({ r, c: c + 1 }), label });
      }
    }
  }
  return out.slice(0, MAX_FIELDS).map((f, i) => ({ ...f, id: `f${i + 1}`, label: tidy(f.label) || `Field ${i + 1}` }));
}

const isZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b;

async function detectSheet(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(Buffer.from(buf), { type: 'buffer' });
  return sheetBlanks(wb).map(({ id, label }) => ({ id, label, type: 'text' }));
}

async function fillSheet(buf, answers) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(Buffer.from(buf), { type: 'buffer' });
  const blanks = sheetBlanks(wb).filter((f) => answers[f.id] !== undefined && answers[f.id] !== null && answers[f.id] !== '');
  if (!isZip(buf)) {
    // .xls: rewrite through SheetJS.
    for (const f of blanks) wb.Sheets[f.sheet][f.ref] = { t: 's', v: String(answers[f.id]) };
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }));
  }
  // .xlsx: edit the sheet XML directly so the form's formatting survives.
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sheetPath = (name) => {
    const sheet = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0])
      .find((s) => xmlUnesc((s.match(/name="([^"]*)"/) || [])[1] || '') === name);
    const rid = sheet && (sheet.match(/r:id="([^"]*)"/) || [])[1];
    const rel = rid && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((x) => x.includes(`Id="${rid}"`));
    const target = rel && (rel.match(/Target="([^"]*)"/) || [])[1];
    return target && (target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  };
  const colNum = (ref) => XLSX.utils.decode_cell(ref).c;
  const bySheet = new Map();
  for (const f of blanks) bySheet.set(f.sheet, [...(bySheet.get(f.sheet) || []), f]);
  for (const [sheet, list] of bySheet) {
    const file = sheetPath(sheet);
    if (!file || !zip.file(file)) continue;
    let xml = await zip.file(file).async('string');
    for (const f of list) {
      const rowNum = XLSX.utils.decode_cell(f.ref).r + 1;
      const cellXml = (style) => `<c r="${f.ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(answers[f.id])}</t></is></c>`;
      const rowRe = new RegExp(`<row\\b[^>]*\\br="${rowNum}"[^>]*?(?:/>|>([\\s\\S]*?)</row>)`);
      const row = xml.match(rowRe);
      if (!row) continue;
      let inner = row[1] || '';
      const existing = inner.match(new RegExp(`<c\\b[^>]*\\br="${f.ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`));
      if (existing) {
        const style = (existing[0].match(/\ss="\d+"/) || [''])[0];
        inner = inner.replace(existing[0], cellXml(style));
      } else {
        // Cells must stay in column order.
        const after = [...inner.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"/g)].find((m) => colNum(m[1]) > colNum(f.ref));
        inner = after ? inner.slice(0, after.index) + cellXml('') + inner.slice(after.index) : inner + cellXml('');
      }
      const open = row[0].match(/^<row\b[^>]*?(?=\/?>)/)[0];
      xml = xml.replace(row[0], `${open}>${inner}</row>`);
    }
    zip.file(file, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- entry points ----------

const FORMATS = {
  pdf: [detectPdf, fillPdf],
  docx: [detectDocx, fillDocx],
  spreadsheet: [detectSheet, fillSheet],
};

const canFill = (kind) => !!FORMATS[kind];

async function detect(kind, buf) {
  if (!FORMATS[kind]) return [];
  return FORMATS[kind][0](Buffer.from(buf));
}

async function fill(kind, buf, answers) {
  if (!FORMATS[kind]) throw new Error('This kind of file cannot be filled in.');
  return FORMATS[kind][1](Buffer.from(buf), answers || {});
}

module.exports = { detect, fill, canFill };
