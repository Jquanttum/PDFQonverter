const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const E = require('../engine.js');

let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }

async function load(bytes) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep, verbosity: 0 }).promise;
}
async function pageText(pdf, n) {
  const p = await pdf.getPage(n);
  const tc = await p.getTextContent();
  return tc.items.map(i => i.str).join(' ');
}

const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const sample = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'samples', 'invoice_edited.pdf')));

  /* ---------- revision scanner ---------- */
  const scan = E.scanRevisions(sample);
  ok(scan.revisions.length === 2, 'scanner finds 2 revisions (got ' + scan.revisions.length + ')');
  ok(scan.version === '1.4', 'PDF version 1.4');
  ok(scan.trailingBytes === 0, 'no trailing bytes');
  const r1 = await load(E.sliceRevision(sample, scan.revisions[0]));
  const r2 = await load(sample);
  const t1 = await pageText(r1, 1), t2 = await pageText(r2, 1);
  ok(/1,000\.00/.test(t1) && !/10,000/.test(t1), 'revision 1 reads GHS 1,000.00');
  ok(/10,000\.00/.test(t2), 'revision 2 reads GHS 10,000.00');
  const m1 = await r1.getMetadata(), m2 = await r2.getMetadata();
  ok(m1.info.Producer === 'Generic Report Writer' && m2.info.Producer === 'Generic PDF Editor', 'producer differs between revisions');

  // trailing junk after final EOF
  const junk = new Uint8Array(sample.length + 12); junk.set(sample); junk.set(Buffer.from('HIDDENPAYLOAD'.slice(0, 12)), sample.length);
  ok(E.scanRevisions(junk).trailingBytes === 12, 'trailing bytes detected');
  // fake %%EOF inside data is ignored
  const fake = Buffer.concat([Buffer.from(sample), Buffer.from('\n%%EOF\n')]);
  ok(E.scanRevisions(new Uint8Array(fake)).revisions.length === 2, 'stray %%EOF not counted as revision');

  /* ---------- metadata analysis ---------- */
  const f1 = E.analyseMetadata({ CreationDate: "D:20260314100000Z", ModDate: "D:20260301100000Z" }, {});
  ok(f1.some(f => /earlier than the creation/.test(f.text)), 'mod < creation flagged');
  const f2 = E.analyseMetadata({ CreationDate: "D:20260314100000Z", Producer: 'A' }, { createDate: '2026-03-15T10:00:00Z', producer: 'B' });
  ok(f2.length === 2, 'info/xmp mismatches flagged (' + f2.length + ')');
  ok(E.parsePdfDate("D:20260302091500+01'00'").toISOString() === '2026-03-02T08:15:00.000Z', 'date with tz offset parsed');

  /* ---------- geometry round-trip ---------- */
  for (const R of [0, 90, 180, 270]) {
    const g = { x0: 10, y0: 20, W: 595, H: 842, R };
    const [px, py] = E.viewToPdf(g, 123, 77);
    const [vx, vy] = E.pdfToView(g, px, py);
    ok(Math.abs(vx - 123) < 1e-9 && Math.abs(vy - 77) < 1e-9, 'view<->pdf round trip R=' + R);
  }

  /* ---------- build: text annotation upright & positioned for every rotation ---------- */
  const geom = { x0: 0, y0: 0, W: 595, H: 842, rot0: 0 };
  for (const extra of [0, 90, 180, 270]) {
    const res = await E.buildPdf({
      PDFLib, sources: { a: sample },
      pages: [{ uid: 1, src: 'a', idx: 0, extra, geom }],
      annotations: { 1: [
        { type: 'text', x: 100, y: 100, text: 'HELLO', size: 20, color: '#ff0000', font: 'Helvetica' },
        { type: 'highlight', x: 50, y: 50, w: 80, h: 20, color: '#ffe600' },
        { type: 'rect', x: 60, y: 300, w: 100, h: 50, color: '#0000ff', width: 2 },
        { type: 'whiteout', x: 60, y: 400, w: 100, h: 20 },
        { type: 'pen', pts: [200, 200, 220, 230, 260, 210], color: '#00aa00', width: 3 },
        { type: 'img', imgId: 'i1', x: 300, y: 300, w: 60, h: 40 }
      ] },
      images: { i1: PNG1 }, rasterize: async () => { throw new Error('should not raster'); }, scrub: false
    });
    const pdf = await load(res.bytes);
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const it = tc.items.find(i => i.str === 'HELLO');
    ok(!!it, 'R=' + extra + ': text annotation present');
    if (it) {
      const m = pdfjs.Util.transform(vp.transform, it.transform);
      const eps = 0.01;
      ok(Math.abs(m[0] - 20) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] + 20) < eps,
         'R=' + extra + ': text is upright in the displayed page (' + m.map(v => v.toFixed(2)).join(',') + ')');
      ok(Math.abs(m[4] - 100) < 0.5 && Math.abs(m[5] - 119) < 0.5, 'R=' + extra + ': baseline at view (100,119) -> (' + m[4].toFixed(2) + ',' + m[5].toFixed(2) + ')');
    }
    ok(res.rasterized.length === 0, 'R=' + extra + ': no rasterisation without redaction');
    // original text still there
    ok(/Account no: 0123456789/.test(await pageText(pdf, 1)), 'R=' + extra + ': original text preserved');
  }

  /* ---------- redaction ---------- */
  // "Account no" line baseline is y=676 (pdf) -> view y = 842-676 = 166
  let rasterCalls = 0;
  const red = await E.buildPdf({
    PDFLib, sources: { a: sample },
    pages: [{ uid: 1, src: 'a', idx: 0, extra: 0, geom }],
    annotations: { 1: [
      { type: 'text', x: 72, y: 150, text: 'SECRETNOTE', size: 12, color: '#000000', font: 'Helvetica' },   // beneath box -> must be dropped
      { type: 'redact', x: 60, y: 150, w: 300, h: 30 },
      { type: 'text', x: 400, y: 150, text: 'REDACTED', size: 12, color: '#ffffff', font: 'Helvetica' }      // above & outside -> kept
    ] },
    images: {}, scrub: true,
    rasterize: async (entry, rects) => { rasterCalls++; ok(rects.length === 1, 'rasterizer receives the redaction rect'); const d = E.dataUrlToBytes(PNG1); return { bytes: d.bytes, mime: 'image/png', w: 595, h: 842 }; }
  });
  const rpdf = await load(red.bytes);
  const rtext = await pageText(rpdf, 1);
  ok(rasterCalls === 1 && red.rasterized.length === 1, 'redacted page rasterised once');
  ok(!/0123456789|Account|INVOICE|10,000/.test(rtext), 'no original text survives on redacted page: "' + rtext.trim() + '"');
  ok(!/SECRETNOTE/.test(rtext), 'annotation under the box was dropped');
  ok(/REDACTED/.test(rtext), 'label placed above the box is kept');
  ok(red.droppedUnderRedaction === 1, 'dropped count reported');
  const raw = Buffer.from(red.bytes).toString('latin1');
  ok(!/0123456789/.test(raw) && !/Account no/.test(raw), 'raw output bytes contain no trace of the redacted string');
  const rmeta = await rpdf.getMetadata();
  ok(!rmeta.info.Producer && !rmeta.info.CreationDate && !rmeta.info.ModDate, 'scrub=true writes no Info fields (' + JSON.stringify(rmeta.info) + ')');

  /* ---------- non-scrub metadata ---------- */
  const keep = await E.buildPdf({ PDFLib, sources: { a: sample }, pages: [{ uid: 1, src: 'a', idx: 0, extra: 0, geom }], annotations: {}, images: {}, scrub: false, rasterize: null });
  const km = await (await load(keep.bytes)).getMetadata();
  ok(km.info.Producer === 'PDF Qonverter', 'producer set to PDF Qonverter');
  ok(String(km.info.CreationDate).startsWith("D:20260302"), 'creation date carried over');
  ok(E.scanRevisions(keep.bytes).revisions.length === 1, 'output is a single clean revision');

  /* ---------- merge + blank page + reorder ---------- */
  const blank = { uid: 9, blank: true, extra: 90, geom: { W: 400, H: 300 } };
  const merged = await E.buildPdf({ PDFLib, sources: { a: sample }, pages: [blank, { uid: 1, src: 'a', idx: 0, extra: 0, geom }], annotations: {}, images: {}, scrub: false, rasterize: null });
  const mp = await load(merged.bytes);
  ok(mp.numPages === 2, 'blank + copied page = 2 pages');
  const bp = await mp.getPage(1);
  ok(bp.rotate === 90 && bp.view[2] === 400 && bp.view[3] === 300, 'blank page size/rotation kept');

  console.log(fail ? ('\n' + fail + ' FAILED') : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
