'use strict';
const assert = require('assert');
const { all } = require('./fixtures');
const { extractAttachments } = require('../src/core/attachments');

(async () => {
  const files = await all();
  const mk = (filename, content, extra = {}) => ({ filename, content, size: content.length, contentType: 'application/octet-stream', ...extra });
  const input = Object.entries(files).map(([n, c]) => mk(n, c));
  // Extras: an image (vision stubbed), an inline signature logo (must be skipped),
  // an unsupported zip, a corrupt PDF, and a spreadsheet detected by MIME type only.
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  input.push(mk('photo of damage.jpg', png, { contentType: 'image/jpeg' }));
  input.push(mk('image001.png', png, { contentType: 'image/png', related: true, cid: 'logo' }));
  input.push(mk('archive.zip', Buffer.from('PK..')));
  input.push(mk('broken.pdf', Buffer.from('%PDF-1.4 garbage')));
  input.push(mk('noext', files['Quote Q-4471.xlsx'], { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));

  const described = [];
  const t0 = Date.now();
  const out = await extractAttachments(input, { describeImage: async (buf, mime, name) => { described.push([name, mime]); return 'Photo shows a cracked lens. Text: "Strand 650W"'; } });
  console.log(`extracted ${out.length} attachments in ${Date.now() - t0} ms\n`);

  for (const a of out) {
    console.log(`${a.status.padEnd(11)} ${String(a.kind).padEnd(12)} ${a.filename}${a.error ? '  — ' + a.error : ''}`);
    if (a.status === 'ok') console.log('            ' + a.text.replace(/\n/g, ' ⏎ ').slice(0, 150));
  }

  const by = Object.fromEntries(out.map((a) => [a.filename, a]));
  for (const name of Object.keys(files)) {
    assert.strictEqual(by[name].status, 'ok', `${name} should be read`);
    if (name !== 'Forwarded.eml') assert.match(by[name].text, /Fresnel/, `${name} has line items`);
  }
  for (const name of ['Quote Q-4471.pdf', 'Quote Q-4471.docx', 'Quote Q-4471.xlsx', 'Quote Q-4471.xls', 'Quote Q-4471.ods', 'Quote Q-4471.odt', 'Quote Q-4471.rtf', 'Quote Q-4471.html']) {
    assert.match(by[name].text, /792/, `${name} has the total`);
  }
  assert.match(by['Quote Q-4471.xlsx'].text, /\[Sheet: Terms\]/, 'all sheets included');
  assert.match(by['Proposal.pptx'].text, /\[Slide 3\][\s\S]*792/, 'slides in numeric order (slide10 last)');
  assert.match(by['Forwarded.eml'].text, /Subject: Fw: Lamp prices[\s\S]*18\.50/);
  assert.match(by['Quote Q-4471.rtf'].text, /£792/, 'RTF hex escapes decoded');
  assert.doesNotMatch(by['Quote Q-4471.rtf'].text, /Arial|Test;/, 'RTF font table/generator stripped');
  assert.match(by['Quote Q-4471.docx'].text, /Strand 650W Fresnel hire\t12\t18\.5\t222/, 'DOCX table rows kept on one line');
  assert.doesNotMatch(by['Quote Q-4471.html'].text, /color:red/, 'HTML styles stripped');
  assert.strictEqual(by['photo of damage.jpg'].status, 'ok');
  assert.deepStrictEqual(described, [['photo of damage.jpg', 'image/jpeg']], 'only the real image sent to vision');
  assert.ok(!by['image001.png'], 'inline signature logo skipped');
  assert.strictEqual(by['archive.zip'].status, 'unsupported');
  assert.strictEqual(by['broken.pdf'].status, 'error');
  assert.strictEqual(by['noext'].status, 'ok', 'detected by MIME type');
  console.log('\nALL PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
