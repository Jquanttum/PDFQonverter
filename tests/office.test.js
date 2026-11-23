// Run:  node tests/office.test.js     (no packages needed; Node 18+ for DecompressionStream)
const fs = require('fs');
const path = require('path');
const C = require('../converter.js');
const O = require('../office.js');

const FX = path.join(__dirname, 'fixtures');
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(FX, n)));
const expected = JSON.parse(fs.readFileSync(path.join(FX, 'office_expected.json'), 'utf8'));
let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }
const all = (r) => r.findings.map((f) => f.text).join('\n');
const has = (r, re, level) => r.findings.some((f) => re.test(f.text) && (!level || f.level === level));
const iso = (d) => d && d.toISOString().replace(/\.\d+Z$/, 'Z');
async function throws(bytes, re, msg) { try { await O.inspect(C, bytes); ok(false, msg + ' (no error)'); } catch (e) { ok(re.test(e.message), msg + ': ' + e.message.slice(0, 80)); } }

(async () => {
  /* ---------- evidence.docx: the full set of things a normal viewer hides ---------- */
  const NOW = new Date('2026-12-01T00:00:00Z');
  const e = await O.inspect(C, fx('evidence.docx'), { now: NOW, name: 'evidence.docx' });
  const ex = expected['evidence.docx'];
  ok(e.kind === 'docx' && e.kindName === 'Word document', 'recognised as a Word document');
  ok(e.core.title === ex.title && e.core.creator === ex.creator && e.core.lastModifiedBy === ex.lastModifiedBy, 'title, author, last-saved-by match python-docx: ' + [e.core.title, e.core.creator, e.core.lastModifiedBy]);
  ok(Number(e.core.revision) === ex.revision, 'revision number matches python-docx (' + e.core.revision + ')');
  ok(iso(e.created) === ex.created && iso(e.modified) === ex.modified, 'created and modified dates match python-docx');
  ok(e.app.application === 'Microsoft Office Word' && e.app.totalTime === '95' && e.app.company === 'Northern Traders Ltd' && e.app.template === 'Normal.dotm', 'extended properties read');
  ok(e.custom.length === 2 && e.custom[1].name === 'ClientCode' && e.custom[1].value === 'NT-0042', 'custom properties read');
  ok(has(e, /sensitivity or classification label.*Confidential/, 'info'), 'sensitivity label found');
  ok(has(e, /modified .* before it was created/, 'warn'), 'modified-before-created is flagged');
  ok(has(e, /parts inside the file are dated 2026-06-10.*last modified 2026-03-02/, 'warn'), 'part dates later than the claimed modified date are flagged');
  ok(has(e, /at least two people/, 'info'), 'author differs from last saved by');
  ok(!has(e, /in the future/), 'no future-date finding when "now" is after every date');
  const early = await O.inspect(C, fx('evidence.docx'), { now: new Date('2026-03-01T00:00:00Z') });
  ok(has(early, /created date .* is in the future/, 'warn') && has(early, /modified date .* is in the future/, 'warn'), 'future dates are flagged relative to "now"');

  // tracked changes
  const t = e.details.tracked;
  ok(t.insertions.count === 2 && t.deletions.count === 1 && t.formatting.count === 1 && t.moves.count === 0, 'tracked changes counted: ' + [t.insertions.count, t.deletions.count, t.formatting.count]);
  ok(JSON.stringify(t.insertions.authors.sort()) === '["Ama Owusu","Kofi Boateng"]' && t.deletions.authors[0] === 'Kofi Boateng', 'authors of changes');
  ok(iso(t.deletions.first) === '2026-03-05T10:30:00Z' && iso(t.insertions.last) === '2026-03-06T14:15:00Z', 'dates of changes');
  ok(t.deletedText.length === 1 && t.deletedText[0] === 'GHS 48,000', 'deleted text recovered: ' + t.deletedText);
  ok(t.insertedText.includes('GHS 52,000') && t.insertedText.includes('Payment within 14 days.'), 'inserted text recovered');
  ok(has(e, /4 tracked changes by .*Ama Owusu.*Kofi Boateng.*Deleted text is still stored in the file: .GHS 48,000/, 'warn'), 'tracked-change finding names people and shows the deleted text');
  // hidden text, comments, rsids
  ok(e.details.hiddenText.length === 1 && e.details.hiddenText[0] === 'Internal: walk-away price is GHS 45,000', 'hidden text recovered');
  ok(has(e, /hidden text .*walk-away price/, 'warn'), 'hidden text finding');
  ok(e.details.comments.length === 1 && e.details.comments[0].author === 'Ama Owusu' && e.details.comments[0].text === 'Confirm quarterly with the supplier.', 'comment read');
  ok(e.details.rsids === 3, 'three editing-session identifiers (rsids)');
  ok(has(e, /3 editing session identifiers.*not a count of people/, 'info'), 'rsid finding says what it is and is not');
  // template, paths, links, thumbnail, orphans, container
  ok(has(e, /attached to a template outside the file.*kofi\.boateng/, 'warn'), 'template path flagged');
  ok(has(e, /path from someone.s computer .*C:\\Users\\kofi\.boateng/, 'warn'), 'user account path flagged');
  ok(e.externals.some((x) => x.type === 'hyperlink' && x.target === 'https://example.org/terms'), 'hyperlink listed as an external reference');
  ok(has(e, /1 web or file link/, 'info'), 'hyperlink counted');
  ok(has(e, /preview picture \(docProps\/thumbnail\.jpeg\)/, 'info'), 'thumbnail noted');
  ok(JSON.stringify(e.orphans) === '["word/secret.txt"]', 'unreferenced part found, and nothing else is called an orphan: ' + e.orphans);
  ok(has(e, /1 part is in the file but nothing points to it: .word\/secret\.txt/, 'warn'), 'orphan finding');
  ok(!has(e, /first part in the zip/), 'no part-order remark when [Content_Types].xml is first');
  ok(e.zip.trailing === null && e.zip.duplicates.length === 0, 'clean container: no trailing data, no duplicates');
  ok(e.findings[0].level === 'warn' && e.findings[e.findings.length - 1].level === 'info', 'warnings listed before notes');
  const titles = e.sections.map((s) => s.title);
  ok(['Document properties', 'Custom properties', 'File container', 'External references', 'Tracked changes', 'Deleted text still in the file', 'Hidden text', 'Comments'].every((s) => titles.includes(s)), 'sections for display: ' + titles.join(' | '));

  /* ---------- container oddities ---------- */
  const tr = await O.inspect(C, fx('trailing.docx'), { now: NOW });
  ok(tr.zip.trailing && tr.zip.trailing.bytes === 'TRAILING-SECRET-DATA'.length, 'bytes after the end of the zip counted: ' + (tr.zip.trailing || {}).bytes);
  ok(tr.zip.trailing.offset === fx('evidence.docx').length, 'trailing data starts exactly where the zip ends');
  ok(has(tr, /20 bytes follow the end of the zip container/, 'warn'), 'trailing data finding');
  const dp = await O.inspect(C, fx('dupe.docx'), { now: NOW });
  ok(JSON.stringify(dp.zip.duplicates) === '["word/document.xml"]' && has(dp, /lists .word\/document\.xml. more than once/, 'warn'), 'duplicate part names flagged');
  const ro = await O.inspect(C, fx('reordered.docx'), { now: NOW });
  ok(has(ro, /Microsoft Word wrote it, but the first part in the zip is ._rels\/\.rels.*Many harmless tools/, 'info'), 'rewritten-by-other-software remark, hedged');

  /* ---------- Excel ---------- */
  const bx = expected['book.xlsx'];
  const x = await O.inspect(C, fx('macro.xlsm'), { now: NOW, name: 'macro.xlsm' });
  ok(x.kind === 'xlsx', 'recognised as an Excel workbook');
  ok(x.core.creator === bx.creator, 'creator matches openpyxl: ' + x.core.creator);
  const states = {}; x.details.sheets.forEach((s) => { states[s.name] = s.state; });
  ok(JSON.stringify(states) === JSON.stringify(bx.sheets), 'sheet states match openpyxl: ' + JSON.stringify(states));
  const hr = {}, hc = {}, cm = {};
  x.details.sheets.forEach((s) => { hr[s.name] = s.hiddenRows; hc[s.name] = s.hiddenCols; cm[s.name] = s.comments; });
  ok(JSON.stringify(Object.values(hr)) === JSON.stringify(Object.values(bx.hiddenRows).map((a) => a.length)), 'hidden rows match openpyxl: ' + JSON.stringify(hr));
  ok(JSON.stringify(Object.values(hc)) === JSON.stringify(Object.values(bx.hiddenCols).map((a) => a.length)), 'hidden columns match openpyxl: ' + JSON.stringify(hc));
  ok(JSON.stringify(Object.values(cm)) === JSON.stringify(Object.values(bx.comments)), 'comment counts match openpyxl: ' + JSON.stringify(cm));
  ok(has(x, /1 sheet is hidden: .Payroll./, 'warn') && has(x, /1 hidden row and 1 hidden column/, 'warn'), 'hidden sheet, row and column flagged');
  ok(has(x, /macro project \(xl\/vbaProject\.bin\).*never runs them/, 'warn'), 'macro project flagged, never run');
  ok(has(x, /1 cell comment or note by .Unknown Author./, 'info'), 'comment author read');
  const bk = await O.inspect(C, fx('book.xlsx'), { now: NOW, name: 'book.xlsx' });
  ok(bk.macros.length === 0 && !has(bk, /macro/i), 'the same workbook without the VBA project has no macro finding');
  const lo = await O.inspect(C, fx('leftover.xlsx'), { now: NOW });
  ok(lo.details.leftoverStrings.length === 2 && lo.details.leftoverStrings[0].startsWith('Old balance 91,250.00') && lo.details.leftoverStrings[1].includes('missing receipt'), 'unused shared strings recovered: ' + lo.details.leftoverStrings.length);
  ok(!lo.details.leftoverStrings.includes('Maize (50kg bag)') && !lo.details.leftoverStrings.includes('Item'), 'strings that cells do use are not reported');
  ok(has(lo, /2 text values are stored in the workbook but no cell uses them/, 'warn'), 'leftover-text finding');
  ok(!has(bk, /no cell uses/), 'a normal workbook has no leftover-text finding');

  /* ---------- PowerPoint ---------- */
  const p = await O.inspect(C, fx('hidden.pptx'), { now: NOW });
  ok(p.kind === 'pptx' && p.details.slides.length === 3, 'three slides read');
  ok(JSON.stringify(p.details.slides.filter((s) => s.hidden).map((s) => s.n)) === '[2]', 'slide 2 is hidden');
  ok(has(p, /1 slide is hidden \(slide 2\).*Layoff plan: 14 roles/, 'warn'), 'hidden slide flagged with its text');
  ok(p.details.slides[2].notes === 'Do not mention the supplier dispute unless asked.' && has(p, /1 slide has speaker notes/, 'info'), 'speaker notes recovered');
  ok(p.details.comments === 1 && p.details.commentAuthors[0] === 'Yaw Mensah', 'comment and its author found');
  ok(p.core.creator === 'Esi Darko' && !has(p, /parts inside the file are dated/), 'consistent dates: no date warning');

  /* ---------- a file made by python-docx ---------- */
  const sd = await O.inspect(C, fx('sample.docx'), { now: NOW });
  ok(sd.core.creator === expected['sample.docx'].creator && Number(sd.core.revision) === expected['sample.docx'].revision, 'sample.docx creator and revision match python-docx (' + sd.core.creator + ')');
  ok(has(sd, /preview picture/, 'info'), 'python-docx\u2019s template thumbnail is noticed');
  ok(has(sd, /parts inside the file are dated 2026.*last modified 2013/, 'warn'), 'python-docx never updates "modified", so the part dates give it away (correct finding)');
  ok(sd.orphans.length === 0 && sd.zip.duplicates.length === 0, 'no false orphan or duplicate findings on an ordinary file');

  /* ---------- refusals are clear ---------- */
  await throws(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), /not a zip container/, 'random bytes');
  await throws(new Uint8Array(0), /not a zip container/, 'empty file');
  await throws(Uint8Array.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]), /older Office file|password-protected/, 'legacy OLE container');
  await throws(fx('invoice.pdf' in {} ? 'x' : '../../samples/invoice_edited.pdf'), /not a zip container/, 'a PDF');
  await throws(C.zipStore([{ name: 'hello.txt', data: new TextEncoder().encode('hi') }]), /no \[Content_Types\]\.xml/, 'a plain zip');
  await throws(C.zipStore([{ name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') }]), /does not look like a Word, Excel or PowerPoint/, 'a zip that is not an Office document');
  const cut = fx('evidence.docx').slice(0, 2000);
  await throws(cut, /not a zip container|damaged/, 'a truncated file');

  /* ---------- nothing in the output can be markup: values are raw strings, escaped at display time ---------- */
  ok(O.clip('a'.repeat(500), 20).length === 20 && O.clip(' a  b ', 10) === 'a b', 'clip() shortens and tidies whitespace');
  ok(O.resolve('word/document.xml', '../media/a.png') === 'media/a.png' && O.resolve('word/_rels/x', '/docProps/core.xml') === 'docProps/core.xml', 'relationship paths resolve');

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})();
