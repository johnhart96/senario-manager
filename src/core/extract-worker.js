'use strict';

// Runs in a worker thread: turns one attachment into plain text.
// Kept separate from the main process so a malformed or hostile file can only
// crash or stall this worker, which the caller times out and terminates.

const { parentPort, workerData } = require('worker_threads');

const decode = (buf) => Buffer.from(buf).toString('utf8');

function xmlText(xml, breakTags) {
  return xml
    .replace(new RegExp(`</(${breakTags})>`, 'g'), '\n')
    .replace(/<(text:tab|w:tab)\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pdf(buf) {
  const { getDocumentProxy, extractText } = require('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  return text.map((t, i) => (totalPages > 1 ? `[Page ${i + 1}]\n${t.trim()}` : t.trim())).join('\n\n');
}

// Via HTML so tables keep one line per row (cells tab-separated), which matters for quotes.
async function docx(buf) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(buf) });
  return html(Buffer.from(value.replace(/<\/p>\s*(?=<\/td>)/g, '')));
}

async function doc(buf) {
  const WordExtractor = require('word-extractor');
  const d = await new WordExtractor().extract(Buffer.from(buf));
  return [d.getBody(), d.getFootnotes(), d.getEndnotes()].filter((s) => s && s.trim()).join('\n\n');
}

function spreadsheet(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(Buffer.from(buf), { type: 'buffer', cellDates: true, dense: true });
  return wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, strip: true });
    return `[Sheet: ${name}]\n${csv.trim()}`;
  }).join('\n\n');
}

async function pptx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(buf));
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const out = [];
  for (const [i, f] of slides.entries()) {
    out.push(`[Slide ${i + 1}]\n${xmlText(await zip.file(f).async('string'), 'a:p')}`);
  }
  return out.join('\n\n');
}

async function openDocument(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(buf));
  const content = zip.file('content.xml');
  if (!content) throw new Error('missing content.xml');
  return xmlText(await content.async('string'), 'text:p|text:h|draw:page');
}

// Removes a {\keyword ...} group, including nested braces.
function dropGroups(src, keywords) {
  const re = new RegExp(`\\{\\\\(\\*\\\\)?(${keywords})\\b`, 'g');
  let out = src;
  let m;
  while ((m = re.exec(out))) {
    let depth = 0;
    let i = m.index;
    for (; i < out.length; i++) {
      if (out[i] === '\\') { i++; continue; }
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) break;
    }
    out = out.slice(0, m.index) + out.slice(i + 1);
    re.lastIndex = m.index;
  }
  return out;
}

function rtf(buf) {
  return dropGroups(decode(buf), 'fonttbl|colortbl|stylesheet|info|listtable|listoverridetable|generator|pict|themedata|datastore|latentstyles')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function html(buf) {
  return decode(buf)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function email(buf) {
  const { simpleParser } = require('mailparser');
  const m = await simpleParser(Buffer.from(buf));
  return `From: ${m.from ? m.from.text : ''}\nTo: ${m.to ? m.to.text : ''}\nDate: ${m.date || ''}\nSubject: ${m.subject || ''}\n\n${(m.text || '').trim()}`;
}

const HANDLERS = { pdf, docx, doc, spreadsheet, pptx, opendocument: openDocument, rtf, html, email, text: decode };

(async () => {
  const { kind, data } = workerData;
  try {
    const text = await HANDLERS[kind](data);
    parentPort.postMessage({ ok: true, text: String(text || '') });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  }
})();
