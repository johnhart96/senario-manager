'use strict';
// Builds genuine test documents for every supported attachment type.
const XLSX = require('xlsx');
const JSZip = require('jszip');

const LINES = [
  ['Item', 'Qty', 'Unit price', 'Total'],
  ['Strand 650W Fresnel hire', 12, 18.5, 222],
  ['Wet hire technician (day)', 2, 285, 570],
];
const TOTAL = 'Grand total: £792.00';

function pdf() {
  // Minimal valid PDF with one page of text and a correct xref table.
  const lines = ['QUOTE Q-4471 for Riverside Theatre Entertainment', ...LINES.slice(1).map((r) => r.join('  ')), TOTAL];
  const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c).replace(/£/g, 'GBP ');
  const stream = 'BT /F1 12 Tf 50 750 Td 16 TL\n' + lines.map((l) => `(${esc(l)}) Tj T*`).join('\n') + '\nET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function sheet(bookType) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...LINES, [], [TOTAL]]), 'Quote Q-4471');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Terms'], ['50% deposit, balance 30 days']]), 'Terms');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

async function docx() {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const rows = LINES.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('Quotation Q-4471')}<w:tbl>${rows}</w:tbl>${p(TOTAL)}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function pptx() {
  const z = new JSZip();
  const slide = (texts) => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  z.file('ppt/slides/slide1.xml', slide(['Lighting proposal', 'Riverside Theatre Entertainment']));
  z.file('ppt/slides/slide2.xml', slide(LINES.slice(1).map((r) => r.join(' - '))));
  z.file('ppt/slides/slide10.xml', slide([TOTAL]));
  return z.generateAsync({ type: 'nodebuffer' });
}

async function odt() {
  const z = new JSZip();
  z.file('mimetype', 'application/vnd.oasis.opendocument.text');
  z.file('content.xml', `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h>Quotation Q-4471</text:h>${LINES.slice(1).map((r) => `<text:p>${r.join(' | ')}</text:p>`).join('')}<text:p>${TOTAL.replace('&', '&amp;')}</text:p></office:text></office:body></office:document-content>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

const rtf = () => Buffer.from(`{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\*\\generator Test;}\\f0 Quotation Q-4471\\par ${LINES.slice(1).map((r) => r.join(' ')).join('\\par ')}\\par Grand total: \\'a3792.00\\par}`, 'latin1');
const html = () => Buffer.from(`<html><style>p{color:red}</style><body><h1>Quotation Q-4471</h1><table>${LINES.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table><p>${TOTAL}</p></body></html>`);
const eml = () => Buffer.from(`From: Supplier <sales@lamps.local>\r\nTo: john@northwind.local\r\nSubject: Fw: Lamp prices\r\n\r\nOur price for Strand 650W Fresnel is 18.50 per day.\r\n`);

async function all() {
  return {
    'Quote Q-4471.pdf': pdf(),
    'Quote Q-4471.docx': await docx(),
    'Quote Q-4471.xlsx': sheet('xlsx'),
    'Quote Q-4471.xls': sheet('biff8'),
    'Quote Q-4471.ods': sheet('ods'),
    'Quote Q-4471.csv': Buffer.from(XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(LINES))),
    'Proposal.pptx': await pptx(),
    'Quote Q-4471.odt': await odt(),
    'Quote Q-4471.rtf': rtf(),
    'Quote Q-4471.html': html(),
    'Forwarded.eml': eml(),
  };
}

module.exports = { all, TOTAL };
