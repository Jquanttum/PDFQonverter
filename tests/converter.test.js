// Run:  node tests/converter.test.js     (needs: npm install pdf-lib@1.17.1 pdfjs-dist@3.11.174)
const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const C = require('../converter.js');

const FX = path.join(__dirname, 'fixtures');
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(FX, n)));
const FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function load(bytes) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: FONTS, verbosity: 0 }).promise;
}
async function allText(pdf) {
  let s = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    s += tc.items.map(x => x.str).join(' ') + '\n';
  }
  return s;
}

(async () => {
  /* ---------- zip ---------- */
  const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello zip') }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }, { name: 'caf\u00e9.txt', data: new Uint8Array(0) }];
  const z = C.zipStore(files);
  const zr = C.zipRead(z);
  ok(same(zr.names, ['a.txt', 'dir/b.bin', 'caf\u00e9.txt']), 'zip write/read keeps names (incl. UTF-8)');
  ok(new TextDecoder().decode(await zr.get('a.txt')) === 'hello zip', 'zip stored entry reads back');
  ok(same(Array.from(await zr.get('dir/b.bin')), [0, 1, 2, 255]), 'binary entry intact');
  ok(C.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'crc32 matches the standard check value');
  let threw = false; try { C.zipRead(new Uint8Array(100)); } catch (e) { threw = true; }
  ok(threw, 'non-zip input is rejected');

  /* ---------- docx reading (file made by python-docx, deflate-compressed) ---------- */
  const doc = await C.readDocx(fx('sample.docx'));
  const B = doc.blocks;
  ok(B[0].kind === 'h1' && B[0].text === 'Quarterly Report', 'heading 1 recognised');
  ok(/caf\u00e9 \u2014 \u201cquoted\u201d text and \u4e2d\u6587 characters & <angle> brackets\./.test(B[1].text), 'entities and unicode decoded: ' + JSON.stringify(B[1].text));
  ok(B[2].bold === true && B[1].bold === false, 'fully bold paragraph detected');
  ok(B[3].kind === 'h2', 'heading 2 recognised');
  ok(B[4].list && B[5].list && B[4].text === 'First item', 'bullet list items recognised');
  const tbl = B.find(b => b.type === 'table');
  ok(tbl && same(tbl.rows, [['Name', 'Amount'], ['Stock audit', 'GHS 1,000.00']]), 'table rows and cells parsed');
  ok(B.some(b => b.type === 'p' && b.text.indexOf('\f') >= 0), 'page break captured');
  ok(B[B.length - 1].text === 'Text on the second page.', 'trailing text kept, trailing blanks trimmed');
  ok(doc.stats.tables === 1 && doc.stats.pictures === 0, 'stats: 1 table, 0 pictures');
  let bad = ''; try { await C.readDocx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])); } catch (e) { bad = e.message; }
  ok(/not a \.docx/.test(bad), 'old/other formats give a helpful error');
  const notDocx = C.zipStore([{ name: 'x.txt', data: new Uint8Array(3) }]);
  bad = ''; try { await C.readDocx(notDocx); } catch (e) { bad = e.message; }
  ok(/word\/document\.xml/.test(bad), 'zip without document.xml is rejected');

  /* ---------- docx writing, round trip ---------- */
  const paras = [
    { text: 'Title & <Co>', kind: 'h1' }, { text: 'Line one\ttabbed\nsecond line', kind: 'p' },
    { text: 'Page two', kind: 'p', pageBreakBefore: true }, { text: 'Control\u0001char removed', kind: 'p' }
  ];
  const built = C.buildDocx(paras, { pageW: 612, pageH: 792 });
  fs.writeFileSync(path.join(process.env.QPDF_TMP || '/tmp', 'built.docx'), built);
  const rd = await C.readDocx(built);
  ok(rd.blocks[0].kind === 'h1' && rd.blocks[0].text === 'Title & <Co>', 'written heading reads back with escaping intact');
  ok(rd.blocks[1].text === 'Line one\ttabbed\nsecond line', 'tabs and line breaks survive');
  ok(rd.blocks[2].pageBreakBefore === true, 'page break before survives');
  ok(rd.blocks[3].text === 'Controlchar removed', 'XML-invalid control characters are dropped');
  ok(/w:w="12240" w:h="15840"/.test(new TextDecoder().decode(await C.zipRead(built).get('word/document.xml'))), 'page size written in twips');

  /* ---------- ranges ---------- */
  ok(same(C.parseRanges('', 5).pages, [0, 1, 2, 3, 4]) && same(C.parseRanges('ALL', 3).pages, [0, 1, 2]), 'empty / all selects every page');
  ok(same(C.parseRanges('1-3, 5, 8-', 9).pages, [0, 1, 2, 4, 7, 8]), 'ranges with open end');
  ok(same(C.parseRanges('-2', 5).pages, [0, 1]), 'open start');
  ok(same(C.parseRanges('2,2,1-2', 5).pages, [1, 0]), 'duplicates removed, order kept');
  ok(C.parseRanges('0', 5).error && C.parseRanges('6', 5).error && C.parseRanges('3-2', 5).error && C.parseRanges('a', 5).error, 'bad ranges give an error');

  /* ---------- images ---------- */
  const photo = fx('photo_orient6_gps.jpg'), plain = fx('plain.jpg'), png = fx('pixel.png');
  ok(C.sniffImage(photo) === 'jpeg' && C.sniffImage(png) === 'png', 'sniffed by content, not by name');
  const heic = new Uint8Array(24); heic.set(Array.from('ftypheic').map(c => c.charCodeAt(0)), 4);
  ok(C.sniffImage(heic) === 'heic' && C.sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])) === 'unknown', 'HEIC and unknown detected');
  ok(C.pngSize(png).width === 40 && C.pngSize(png).height === 30, 'PNG size read from header');
  const pi = C.jpegInfo(photo);
  ok(pi.valid && pi.width === 64 && pi.height === 48, 'JPEG size read');
  ok(pi.orientation === 6 && pi.hasExif && pi.hasGps && pi.hasOther, 'EXIF orientation, GPS and comment detected');
  const pl = C.jpegInfo(plain);
  ok(pl.orientation === 1 && !pl.hasExif && !pl.hasGps && !pl.hasOther, 'plain JPEG reports nothing');
  const st = C.stripJpegMetadata(photo);
  const si = C.jpegInfo(st.bytes);
  ok(st.removed.indexOf('EXIF') >= 0 && st.removed.indexOf('comment') >= 0, 'stripper reports what it removed: ' + st.removed.join(', '));
  ok(si.valid && !si.hasExif && !si.hasGps && !si.hasOther && si.width === 64 && si.height === 48, 'stripped file has no EXIF/GPS/comment and same size');
  ok(st.bytes.length === photo.length - st.removedBytes, 'only metadata bytes were removed (lossless)');
  ok(C.stripJpegMetadata(plain).bytes === plain, 'nothing to strip returns the same bytes');
  fs.writeFileSync(path.join(process.env.QPDF_TMP || '/tmp', 'stripped.jpg'), st.bytes);

  const mk = (b, mime, w, h) => ({ bytes: b, mime, w, h });
  const sets = {};
  for (const ps of ['fit', 'a4', 'letter']) {
    const r = await C.imagesToPdf({ PDFLib, images: [mk(st.bytes, 'image/jpeg', 64, 48), mk(png, 'image/png', 40, 30), mk(plain, 'image/jpeg', 48, 64)], pageSize: ps, margin: 18, scrub: false, title: 'x' });
    const pdf = await load(r.bytes);
    const sizes = []; for (let i = 1; i <= pdf.numPages; i++) { const v = (await pdf.getPage(i)).view; sizes.push([+(v[2] - v[0]).toFixed(1), +(v[3] - v[1]).toFixed(1)]); }
    sets[ps] = { pages: pdf.numPages, sizes, bytes: r.bytes };
  }
  ok(sets.fit.pages === 3 && sets.fit.sizes[0][0] === 48 && sets.fit.sizes[0][1] === 36, 'fit mode: page matches image (small image at 0.75): ' + JSON.stringify(sets.fit.sizes[0]));
  ok(same(sets.a4.sizes[0], [841.9, 595.3]) && same(sets.a4.sizes[2], [595.3, 841.9]), 'A4: landscape image gets landscape page, portrait gets portrait');
  ok(same(sets.letter.sizes[1], [792, 612]), 'Letter landscape page size');
  const info = await (await load(sets.a4.bytes)).getMetadata();
  ok(info.info.Producer === 'PDF Qonverter' && !!info.info.CreationDate, 'producer and creation date set');
  const scrubbed = await C.imagesToPdf({ PDFLib, images: [mk(plain, 'image/jpeg', 64, 48)], pageSize: 'a4', margin: 0, scrub: true });
  const sm = await (await load(scrubbed.bytes)).getMetadata();
  ok(!sm.info.Producer && !sm.info.CreationDate && !sm.info.Title, 'scrub leaves out all document metadata');
  const rawStripped = Buffer.from(sets.a4.bytes).toString('latin1');
  ok(rawStripped.indexOf('Exif') < 0 && rawStripped.indexOf('private note') < 0 && rawStripped.indexOf('TestCam') < 0, 'no EXIF, camera name or comment anywhere in the PDF built from the stripped photo');
  const rawLeaky = Buffer.from((await C.imagesToPdf({ PDFLib, images: [mk(photo, 'image/jpeg', 64, 48)], pageSize: 'a4', margin: 0, scrub: true })).bytes).toString('latin1');
  ok(rawLeaky.indexOf('TestCam') >= 0, 'control: embedding the ORIGINAL photo does carry EXIF into the PDF (that is why stripping matters)');
  let reenc = 0;
  const fb = await C.imagesToPdf({ PDFLib, images: [mk(new Uint8Array([1, 2, 3]), 'image/png', 10, 10)], pageSize: 'a4', margin: 0, scrub: true, reencode: async () => { reenc++; return mk(png, 'image/png', 40, 30); } });
  ok(reenc === 1 && fb.pages === 1, 'undecodable image falls back to re-encode hook');

  /* ---------- text -> PDF ---------- */
  const longText = Array.from({ length: 120 }, (_, i) => 'Line ' + (i + 1) + ' of the evidence log').join('\n');
  const t1 = await C.textToPdf({ PDFLib, text: longText, font: 'Helvetica', size: 11, pageSize: 'a4', margin: 54, pageNumbers: true, scrub: false, title: 'log' });
  const p1 = await load(t1.bytes), tx1 = await allText(p1);
  ok(t1.pages >= 2 && p1.numPages === t1.pages, 'long text flows onto ' + t1.pages + ' pages');
  ok(tx1.indexOf('Line 1 of the evidence log') >= 0 && tx1.indexOf('Line 120 of the evidence log') >= 0, 'first and last lines present');
  ok(new RegExp('1 / ' + t1.pages).test(tx1), 'page numbers drawn');
  const t2 = await C.textToPdf({ PDFLib, text: 'Caf\u00e9 \u4e2d\u6587\u2192x\n\n\u00a0indented\fnew page', font: 'Courier', size: 10, pageSize: 'letter', margin: 40, scrub: true });
  const tx2 = await allText(await load(t2.bytes));
  ok(t2.pages === 2, 'form feed starts a new page');
  ok(t2.replaced === 2 && /Caf\u00e9 \?\?->x/.test(tx2), 'unencodable characters become ? and are counted (' + t2.replaced + '); arrow mapped to ->');
  const t3 = await C.textToPdf({ PDFLib, text: 'W'.repeat(400), font: 'Courier', size: 12, pageSize: 'a4', margin: 54, scrub: true });
  ok((await allText(await load(t3.bytes))).replace(/\s/g, '').length === 400, 'overlong word is broken, nothing lost');
  const t4 = await C.textToPdf({ PDFLib, text: '', font: 'Times', size: 11, pageSize: 'a4', margin: 54, scrub: true });
  ok(t4.pages === 1, 'empty text still gives a valid one-page PDF');
  const w = C.wrap('aaa bbb ccc', (await (async () => { const d = await PDFLib.PDFDocument.create(); return d.embedFont('Courier'); })()), 10, 40);
  ok(w.length >= 2 && w.join(' ').replace(/\s+/g, ' ').trim() === 'aaa bbb ccc', 'wrap keeps all words');

  /* ---------- Word -> PDF ---------- */
  const w1 = await C.docxToPdf({ PDFLib, blocks: B, font: 'Helvetica', size: 11, pageSize: 'a4', margin: 72, scrub: false, title: 'sample' });
  const wp = await load(w1.bytes), wt = await allText(wp);
  ok(wp.numPages === 2, 'page break respected: 2 pages (got ' + wp.numPages + ')');
  ok(wt.indexOf('Quarterly Report') >= 0 && wt.indexOf('Stock audit') >= 0 && wt.indexOf('GHS 1,000.00') >= 0 && wt.indexOf('Text on the second page.') >= 0, 'headings, table cells and later text all present');
  ok(wt.indexOf('Entirely bold line') >= 0 && wt.indexOf('First item') >= 0 && wt.indexOf('\u2022') >= 0, 'bold line and bullet list present');
  ok(w1.replaced === 2, '2 Chinese characters reported as replaced');
  const secondPage = (await (await wp.getPage(2)).getTextContent()).items.map(x => x.str).join(' ');
  ok(secondPage.indexOf('Text on the second page.') >= 0 && secondPage.indexOf('Quarterly') < 0, 'content after the break is on page 2');
  const bigTable = { type: 'table', rows: Array.from({ length: 80 }, (_, i) => ['Row ' + i, 'x '.repeat(30)]) };
  const w2 = await C.docxToPdf({ PDFLib, blocks: [bigTable], font: 'Times', size: 11, pageSize: 'letter', margin: 50, scrub: true });
  const tt = await allText(await load(w2.bytes));
  ok(w2.pages > 1 && tt.indexOf('Row 0') >= 0 && tt.indexOf('Row 79') >= 0, 'long table splits across pages without losing rows (' + w2.pages + ' pages)');

  /* ---------- PDF text -> lines / paragraphs ---------- */
  const it = (str, x, y, w, h) => ({ str, x, y, w, h });
  const items = [
    it('Annual', 50, 60, 70, 24), it('Report', 130, 60, 80, 24),
    it('This is the first', 50, 120, 120, 11), it('sentence of a para-', 175, 120, 100, 11),
    it('graph that wraps.', 50, 134, 90, 11),
    it('Second paragraph starts here.', 50, 170, 160, 11),
    it('Name', 50, 210, 30, 11), it('Amount', 250, 210, 40, 11),
    it('', 10, 10, 0, 0), it('   ', 20, 20, 5, 5)
  ];
  const lines = C.layoutLines(items);
  ok(lines.length === 5 && lines[0].text === 'Annual Report', 'words on one baseline joined into a line: ' + JSON.stringify(lines.map(l => l.text)));
  ok(lines[3].text === 'Second paragraph starts here.' && lines[4].text === 'Name\tAmount', 'wide gap becomes a tab, blank items ignored');
  const paras2 = C.toParagraphs(lines);
  ok(paras2[0].kind === 'h1' && paras2[0].text === 'Annual Report', 'large text becomes a heading');
  ok(paras2[1].text === 'This is the first sentence of a para-graph that wraps.' && paras2[1].kind === 'p', 'wrapped lines merge into one paragraph');
  ok(paras2[2].text === 'Second paragraph starts here.' && paras2.length === 4, 'vertical gap starts a new paragraph; table-like row kept apart');
  const txt = C.textFromPages([{ num: 1, lines: lines.slice(0, 2) }, { num: 3, lines: lines.slice(3, 4) }], { mode: 'lines', mark: true });
  ok(/^----- Page 1 -----\n\nAnnual Report\nThis is the first sentence of a para-\n\n\n----- Page 3 -----\n\nSecond paragraph starts here\.$/.test(txt) || (txt.indexOf('----- Page 3 -----') > 0 && txt.indexOf('Annual Report') > 0), 'page markers keep the real page numbers');
  ok(C.textFromPages([{ num: 1, lines: lines }], { mode: 'paragraphs', mark: false }).split('\n\n').length === 4, 'paragraph mode separates with blank lines');

  /* ---------- real PDF through pdf.js (the sample invoice) ---------- */
  const sample = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'samples', 'invoice_edited.pdf')));
  const sp = await load(sample), pg = await sp.getPage(1), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
  const real = tc.items.map(i => { const m = pdfjs.Util.transform(vp.transform, i.transform); return { str: i.str, x: m[4], y: m[5], w: i.width, h: Math.hypot(m[2], m[3]) }; });
  const rl = C.layoutLines(real).map(l => l.text);
  ok(same(rl, ['INVOICE No. 2026-0417', 'Prepared for: Ama Mensah Stores, Kumasi', 'Account no: 0123456789', 'Services rendered: stock audit, March 2026', 'Amount due: GHS 10,000.00']), 'real PDF lines reconstructed top to bottom: ' + JSON.stringify(rl));
  const rp = C.toParagraphs(C.layoutLines(real));
  ok(rp[0].kind === 'h2' || rp[0].kind === 'h1', 'invoice title detected as heading (' + rp[0].kind + ')');

  /* ---------- misc ---------- */
  ok(C.safeBase('My: report?.final.pdf') === 'My_ report_.final' && C.safeBase('') === 'document', 'file names are made safe');

  console.log(fail ? ('\n' + fail + ' FAILED') : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
