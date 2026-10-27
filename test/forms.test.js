'use strict';
// Forms: finding the blanks in PDF, Word and Excel forms and filling them in, keeping
// the original layout, and reading the filled file back.
const assert = require('assert');
const ROOT = require('path').join(__dirname, '..');
const JSZip = require(ROOT + '/node_modules/jszip');
const XLSX = require(ROOT + '/node_modules/xlsx');
const { PDFDocument } = require(ROOT + '/node_modules/pdf-lib');
const docxLib = require(ROOT + '/node_modules/docx');
const forms = require(ROOT + '/src/core/forms');
const { extractAttachments } = require(ROOT + '/src/core/attachments');

const byLabel = (fields, re) => fields.find((f) => re.test(f.label));
const readBack = async (filename, content) => (await extractAttachments([{ filename, content, size: content.length, contentType: '' }]))[0].text;

async function pdfForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  page.drawText('Credit account application', { x: 50, y: 790, size: 18 });
  const text = (name, y) => { page.drawText(name, { x: 50, y, size: 11 }); form.createTextField(name.replace(/ /g, '')).addToPage(page, { x: 200, y: y - 5, width: 300, height: 20 }); };
  text('Company Name', 740);
  text('Contact Email', 700);
  text('Credit Limit Requested', 660);
  form.createCheckBox('AgreeToTerms').addToPage(page, { x: 200, y: 620, width: 15, height: 15 });
  const dd = form.createDropdown('BusinessType');
  dd.addOptions(['Sole trader', 'Partnership', 'Limited company']);
  dd.addToPage(page, { x: 200, y: 580, width: 200, height: 20 });
  return Buffer.from(await doc.save());
}

async function wordForm() {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun } = docxLib;
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun({ text: 'New account form', bold: true })] }),
    new Table({ rows: [
      new TableRow({ children: [cell('Company name'), cell('')] }),
      new TableRow({ children: [cell('VAT number'), cell('')] }),
    ] }),
    new Paragraph('Accounts contact: ____________________'),
    new Paragraph('Signed: ______________   Date: ______________'),
    new Paragraph('Preferred delivery day: SDTMARKER'),
  ] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  // A content control ("click or tap here to enter text"), as Word's form templates use.
  const sdt = '</w:t></w:r><w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/></w:rPr><w:t>Click or tap here to enter text.</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t>';
  const xml = (await zip.file('word/document.xml').async('string')).replace('SDTMARKER', sdt);
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function excelForm(bookType) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Supplier set-up form'],
    [],
    ['Trading name:'],
    ['Bank sort code:'],
    ['Item', 'Qty', 'Price', 'Total', 'Notes'], // a table header row: not a form field
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Form');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }));
}

(async () => {
  // 1. PDF form fields.
  const pdf = await pdfForm();
  const pf = await forms.detect('pdf', pdf);
  assert.ok(byLabel(pf, /Company Name/), JSON.stringify(pf));
  const agree = byLabel(pf, /Agree To Terms/);
  const type = byLabel(pf, /Business Type/);
  assert.strictEqual(agree.type, 'check');
  assert.deepStrictEqual(type.options, ['Sole trader', 'Partnership', 'Limited company']);
  const pdfOut = await forms.fill('pdf', pdf, { [byLabel(pf, /Company Name/).id]: 'Bright Foods Ltd', [byLabel(pf, /Credit Limit/).id]: '£5,000 – monthly',
    [agree.id]: 'yes', [type.id]: 'limited company' });
  const back = (await PDFDocument.load(pdfOut)).getForm();
  assert.strictEqual(back.getTextField('CompanyName').getText(), 'Bright Foods Ltd');
  assert.strictEqual(back.getTextField('CreditLimitRequested').getText(), '£5,000 - monthly', 'non-Latin-1 dash replaced');
  assert.ok(back.getCheckBox('AgreeToTerms').isChecked());
  assert.deepStrictEqual(back.getDropdown('BusinessType').getSelected(), ['Limited company']);
  assert.strictEqual(back.getTextField('ContactEmail').getText(), undefined, 'unanswered field left blank');
  console.log(`OK 1: PDF form: ${pf.length} fields found and filled (text, tick box, drop-down)`);

  // 2. Word form: table cells, "Label: ____" lines, a content control.
  const word = await wordForm();
  const wf = await forms.detect('docx', word);
  const want = [/^Company name$/, /^VAT number$/, /^Accounts contact$/, /^Signed$/, /Preferred delivery day/];
  for (const re of want) assert.ok(byLabel(wf, re), `${re} in ${JSON.stringify(wf.map((f) => f.label))}`);
  const answers = { [byLabel(wf, /^Company name$/).id]: 'Bright Foods Ltd', [byLabel(wf, /^VAT number$/).id]: 'GB 123 4567 89',
    [byLabel(wf, /^Accounts contact$/).id]: 'Jo Bloggs <jo@bright.local>', [byLabel(wf, /^Signed$/).id]: 'J. Bloggs',
    [byLabel(wf, /Preferred delivery day/).id]: 'Tuesday' };
  const wordOut = await forms.fill('docx', word, answers);
  const wordText = await readBack('form.docx', wordOut);
  assert.match(wordText, /Company name\s+Bright Foods Ltd/);
  assert.match(wordText, /VAT number\s+GB 123 4567 89/);
  assert.match(wordText, /Accounts contact: Jo Bloggs <jo@bright\.local>/);
  assert.match(wordText, /Signed: J\. Bloggs\s+Date: _+/, 'only the answered blank on a shared line is filled');
  assert.match(wordText, /Preferred delivery day: Tuesday/);
  assert.doesNotMatch(wordText, /Click or tap here/);
  // Still well-formed: every element that's opened is closed.
  const xml = await (await JSZip.loadAsync(wordOut)).file('word/document.xml').async('string');
  for (const tag of ['w:p', 'w:r', 'w:t', 'w:tc', 'w:tr', 'w:sdt', 'w:sdtContent']) {
    const open = (xml.match(new RegExp(`<${tag}(?=[\\s>])[^>]*[^/]>|<${tag}>`, 'g')) || []).length;
    const close = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.strictEqual(open, close, `<${tag}> balanced`);
  }
  console.log(`OK 2: Word form: ${wf.length} blanks found (cells, lines, content control) and filled`);

  // 3. Excel forms, modern and pre-2007.
  for (const [bookType, name] of [['xlsx', 'form.xlsx'], ['biff8', 'form.xls']]) {
    const xl = excelForm(bookType);
    const xf = await forms.detect('spreadsheet', xl);
    assert.deepStrictEqual(xf.map((f) => f.label), ['Trading name', 'Bank sort code'], `${name}: ${JSON.stringify(xf)}`);
    const out = await forms.fill('spreadsheet', xl, { f1: 'Bright Foods', f2: '12-34-56' });
    const ws = XLSX.read(out, { type: 'buffer' }).Sheets.Form;
    assert.strictEqual(ws.B3.v, 'Bright Foods');
    assert.strictEqual(ws.B4.v, '12-34-56');
    assert.strictEqual(ws.A5.v, 'Item', 'rest of the sheet untouched');
  }
  console.log('OK 3: Excel forms (.xlsx edited in place, .xls rewritten): label cells found and filled');

  // 4. Nothing to fill.
  assert.deepStrictEqual(await forms.detect('pdf', Buffer.from((await (async () => { const d = await PDFDocument.create(); d.addPage(); return d.save(); })()))), []);
  assert.deepStrictEqual(await forms.detect('rtf', Buffer.from('{\\rtf1 hi}')), []);
  await assert.rejects(forms.fill('rtf', Buffer.from('x'), {}), /cannot be filled/);
  console.log('OK 4: flat PDFs and other formats have no blanks');

  console.log('ALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
