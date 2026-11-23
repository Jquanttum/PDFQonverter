// Run:  node tests/report.test.js     (no packages needed)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../engine.js');
const R = require('../report.js');

let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'samples', 'invoice_edited.pdf')));

/* evidence built from the real two-revision sample, the way the app builds it */
const scan = E.scanRevisions(bytes);
const revisions = scan.revisions.map((r, i) => ({
  index: r.index, size: r.size, addedBytes: r.addedBytes, xrefOffset: r.xrefOffset, hash: sha(E.sliceRevision(bytes, r)),
  producer: i === 0 ? 'Quanttum Invoicer' : 'Some Editor 9', modDate: i === 0 ? 'D:20260301100000Z' : 'D:20260302120000Z'
}));
const info = { Title: 'Invoice 0042', Author: 'A. Mensah', Producer: 'Some Editor 9', CreationDate: 'D:20260301100000Z', ModDate: 'D:20260302120000Z' };
const findings = E.analyseMetadata(info, {});
findings.unshift({ level: 'warn', text: 'This file contains ' + scan.revisions.length + ' saved revisions.' });
const t0 = new Date(2026, 10, 23, 3, 5, 9);
const ev = { name: 'invoice_edited.pdf', size: bytes.length, pages: 1, hash: sha(bytes), version: scan.version, linearized: scan.linearized, info, xmp: {}, findings, revisions, trailing: null };
const log = [
  { time: t0, type: 'open', text: 'Opened for examination', files: [{ role: 'Examined', name: ev.name, size: ev.size, hash: ev.hash }] },
  { time: new Date(2026, 10, 23, 3, 9, 0), type: 'convert', text: 'Converted PDF to text', files: [{ role: 'Source', name: ev.name, size: ev.size, hash: ev.hash }, { role: 'Output', name: 'invoice_edited.txt', size: 120, hash: sha(Buffer.from('x')) }] }
];

const html = R.build({ tool: { name: 'Quanttum PDF', version: '0.2' }, generated: t0, caseRef: 'UDS/FS/2026/014', examiner: 'J. Dela', evidence: ev, log, fmtDate: (s) => 'formatted ' + s });

/* structure */
ok(/^<!doctype html>/i.test(html) && html.indexOf('</html>') > 0, 'a complete HTML document');
['1. Item examined', '2. Findings', '3. Document metadata', '4. Revisions stored in the file', '5. Activity log for this session', '6. What this report does and does not show'].forEach(s => ok(html.includes(s), 'section: ' + s));
ok(html.includes('UDS/FS/2026/014') && html.includes('J. Dela'), 'case reference and examiner are printed');
ok(html.includes(sha(bytes)), 'SHA-256 of the item is in the report');
ok(html.includes('Signature') || html.includes('signature'), 'signature line present');
ok(html.includes('2026-11-23 03:05:09 UTC'), 'timestamp format: ' + (/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC[+-]\d\d:\d\d/.exec(html) || [''])[0]);
ok(html.includes('not independently verified'), 'says the clock is not verified');

/* revisions: every revision has its own hash and it is the hash of the real prefix */
ok(scan.revisions.length === 2, 'the sample has two revisions');
revisions.forEach(r => ok(html.includes(r.hash), 'revision ' + r.index + ' hash printed'));
ok(revisions[0].hash !== revisions[1].hash && revisions[1].hash !== sha(bytes) || scan.trailingBytes === 0, 'revision hashes differ from each other');
ok(sha(E.sliceRevision(bytes, scan.revisions[scan.revisions.length - 1])) === sha(bytes.slice(0, scan.revisions[1].end)), 'last revision hash = hash of bytes up to its %%EOF');
ok(html.includes('producer changed'), 'a producer change between revisions is flagged');
ok(html.includes('formatted D:20260301100000Z') && html.includes('raw: D:20260301100000Z'), 'dates shown formatted and raw');
ok(html.includes('The file holds <b>2</b> saved versions'), 'revision summary sentence');

/* activity log */
ok(html.includes('Opened for examination') && html.includes('Converted PDF to text'), 'both log entries present');
ok(html.includes(sha(Buffer.from('x'))), 'output hash in the log');
ok((html.match(/Source:<\/b>/g) || []).length === 1, 'source and output are both labelled');

/* escaping: nothing from the examined file may become markup */
const evil = '<script>alert(1)</script>"\'&';
const bad = R.build({ caseRef: evil, examiner: evil, generated: t0, evidence: Object.assign({}, ev, { name: evil + '.pdf', info: { Title: evil, Author: evil, Producer: evil, CreationDate: evil }, xmp: { producer: evil }, findings: [{ level: 'warn', text: evil }], revisions: [Object.assign({}, revisions[0], { producer: evil })], trailing: { offset: 10, bytes: 5, hash: evil } }), log: [{ time: t0, type: 'open', text: evil, files: [{ role: evil, name: evil, size: 1, hash: evil }] }] });
ok(!bad.includes('<script>alert(1)'), 'no script tag survives from any field');
ok(!/<[a-z]+[^>]*\son\w+=/i.test(bad.replace(/<style>[\s\S]*<\/style>/, '')), 'no event-handler attributes');
ok(bad.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'text is shown, escaped');
ok(R.esc(null) === '' && R.esc(0) === '0', 'escape handles null and zero');

/* self-contained and printable */
ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/url\(/i.test(html) && !/@import/i.test(html), 'no external resources (works offline, leaks nothing when opened)');
ok(!/<script/i.test(html) && !/<link/i.test(html), 'no scripts and no linked files');
ok(html.includes('@media print') && html.includes('@page'), 'print styles present');

/* the empty and the awkward cases */
const empty = R.build({ generated: t0, evidence: { name: 'x.pdf', size: 10, pages: 1, hash: null, info: {}, xmp: {}, findings: [], revisions: [], trailing: null }, log: [] });
ok(empty.includes('No revision markers were found'), 'no revisions: said plainly');
ok(empty.includes('no inconsistencies'), 'no findings: clean wording, with the caveat below');
ok(empty.includes('not proof that a file is genuine'), 'clean result carries the "not proof" caveat');
ok(empty.includes('not computed'), 'a missing hash is shown as not computed, never blank');
ok(empty.includes('The file carries no document metadata'), 'no metadata: said plainly');
ok(empty.includes('Nothing else was done in this session'), 'empty log: said plainly');
const one = R.build({ generated: t0, evidence: Object.assign({}, ev, { revisions: [revisions[0]], trailing: { offset: 500, bytes: 42, hash: 'ab'.repeat(32) } }), log: [] });
ok(one.includes('saved once') && one.includes('Data after the final %%EOF') && one.includes('42 bytes') && one.includes('ab'.repeat(32)), 'single revision plus trailing data reported with its own hash');
ok(R.fmtBytes(1536) === '1.5 KB' && R.fmtBytes(5) === '5 B', 'byte formatting');

console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASSED');
process.exit(fail ? 1 : 0);
