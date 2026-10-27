'use strict';

// Turns the attachments on an inbound email into text the customer AI can read.

const path = require('path');
const { Worker } = require('worker_threads');

const MAX_BYTES = 25 * 1024 * 1024; // matches the listener's message size limit
const MAX_FORM_BYTES = 1024 * 1024; // forms are kept with the message so they can be filled in
const FORM_EXT = /\.(pdf|docx|docm|xlsx|xlsm|xls)$/i;
const MAX_TEXT = 20000; // characters kept per attachment
const TIMEOUT_MS = 30000;

const BY_EXT = {
  pdf: 'pdf',
  docx: 'docx', docm: 'docx', dotx: 'docx',
  doc: 'doc', dot: 'doc',
  xlsx: 'spreadsheet', xlsm: 'spreadsheet', xls: 'spreadsheet', xlsb: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet',
  pptx: 'pptx', pptm: 'pptx',
  odt: 'opendocument', odp: 'opendocument',
  rtf: 'rtf',
  htm: 'html', html: 'html',
  eml: 'email',
  txt: 'text', text: 'text', md: 'text', json: 'text', xml: 'text', log: 'text', ics: 'text', vcf: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};

const BY_TYPE = [
  [/pdf$/, 'pdf'],
  [/wordprocessingml/, 'docx'],
  [/msword/, 'doc'],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/, 'spreadsheet'],
  [/presentationml/, 'pptx'],
  [/opendocument\.(text|presentation)/, 'opendocument'],
  [/rtf/, 'rtf'],
  [/text\/html/, 'html'],
  [/message\/rfc822/, 'email'],
  [/^text\//, 'text'],
  [/^image\/(png|jpe?g|gif|webp)$/, 'image'],
];

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function kindOf(filename, contentType) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  if (BY_EXT[ext]) return BY_EXT[ext];
  const type = String(contentType || '').toLowerCase();
  const hit = BY_TYPE.find(([re]) => re.test(type));
  return hit ? hit[1] : null;
}

function runWorker(kind, data, extra) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'extract-worker.js'), {
      workerData: { kind, data, extra },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.ok) resolve(m.text);
      else reject(new Error(m.error));
    });
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`parser exited (${code})`));
    });
  });
}

function clip(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  return t.length > MAX_TEXT ? { text: t.slice(0, MAX_TEXT), truncated: true } : { text: t, truncated: false };
}

/**
 * attachments: mailparser attachment objects.
 * describeImage(buffer, mime, filename) -> Promise<string>, used for pictures.
 * Returns [{ filename, contentType, size, kind, status, text, truncated, error }]
 * status: ok | empty | unsupported | too-large | error
 */
async function extractAttachments(attachments, { describeImage } = {}) {
  const out = [];
  for (const a of attachments || []) {
    // Logos and signature images embedded in the HTML body are not real attachments.
    if (a.related || (a.contentDisposition === 'inline' && /^image\//.test(a.contentType || '') && a.cid)) continue;

    const filename = a.filename || `attachment-${out.length + 1}`;
    const item = { filename, contentType: a.contentType || '', size: a.size || (a.content ? a.content.length : 0), kind: kindOf(filename, a.contentType), status: 'ok', text: '' };
    out.push(item);
    try {
      if (!item.kind) {
        item.status = 'unsupported';
        continue;
      }
      if (item.size > MAX_BYTES) {
        item.status = 'too-large';
        continue;
      }
      let text;
      if (item.kind === 'image') {
        if (!describeImage) {
          item.status = 'unsupported';
          continue;
        }
        const ext = path.extname(filename).slice(1).toLowerCase();
        const mime = /^image\//.test(item.contentType) ? item.contentType : IMAGE_MIME[ext] || 'image/png';
        text = await describeImage(a.content, mime, filename);
      } else {
        // Many "Word documents" are really RTF saved with a .doc name; read them as RTF.
        const kind = item.kind === 'doc' && a.content.subarray(0, 5).toString('latin1') === '{\\rtf' ? 'rtf' : item.kind;
        text = await runWorker(kind, new Uint8Array(a.content));
      }
      Object.assign(item, clip(text));
      if (!item.text) item.status = 'empty'; // e.g. a scanned PDF with no text layer
      await findForm(item, a.content);
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
    }
  }
  return out;
}

// A form with blanks to fill in: keep the original and list its blanks.
async function findForm(item, content) {
  if (!['pdf', 'docx', 'spreadsheet'].includes(item.kind) || !FORM_EXT.test(item.filename) || item.size > MAX_FORM_BYTES) return;
  try {
    const fields = await runWorker(`form-detect:${item.kind}`, new Uint8Array(content));
    if (fields.length) item.form = { fields, data: Buffer.from(content).toString('base64') };
  } catch { /* not a form we can fill: it's still read as a document */ }
}

// Fills a form kept by findForm. answers: { [field id]: value } -> Buffer
async function fillForm(attachment, answers) {
  const out = await runWorker(`form-fill:${attachment.kind}`, new Uint8Array(Buffer.from(attachment.form.data, 'base64')), answers);
  return Buffer.from(out);
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const STATUS_NOTE = {
  empty: 'no readable text (it may be a scanned image)',
  unsupported: 'file type cannot be read',
  'too-large': 'too large to read',
  error: 'could not be read',
};

const formLine = (f) => `${f.id}: ${f.label}${f.type === 'check' ? ' (tick box: yes or no)' : f.type === 'choice' ? ` (one of: ${f.options.join(' / ')})` : ''}`;

// Text for the AI prompt. `full` includes the extracted content, otherwise a short excerpt.
function attachmentsForPrompt(list, full) {
  if (!list || !list.length) return '';
  return list
    .map((a) => {
      const head = `[Attachment: ${a.filename} (${fmtSize(a.size)})]`;
      if (a.status !== 'ok') return `${head} — ${STATUS_NOTE[a.status] || a.status}`;
      const body = full ? a.text : a.text.slice(0, 1500) + (a.text.length > 1500 ? '\n…' : '');
      const form = full && a.form && !a.sent ? `\n[Blanks you can fill in on ${a.filename}, by id]\n${a.form.fields.map(formLine).join('\n')}` : '';
      return `${head}${a.truncated && full ? ' (long document, beginning shown)' : ''}\n${body}${form}\n[End of ${a.filename}]`;
    })
    .join('\n\n');
}

module.exports = { extractAttachments, attachmentsForPrompt, fillForm, kindOf, fmtSize };
