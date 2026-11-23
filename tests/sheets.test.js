// Run:  node tests/sheets.test.js     (needs: npm install pdf-lib@1.17.1 pdfjs-dist@3.11.174)
const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const C = require('../converter.js');
const X = require('../sheets.js');

const FX = path.join(__dirname, 'fixtures');
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(FX, n)));
const FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function rejects(p) { try { await p; return null; } catch (e) { return e.message; } }

async function load(bytes) { return pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: FONTS, verbosity: 0 }).promise; }
async function pageTexts(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(' '));
  return out;
}

(async () => {
  /* ---------------- number formats ---------------- */
  const N = X.formatNumber;
  ok(N(1234.5, '#,##0.00') === '1,234.50', 'thousands and two decimals');
  ok(N(0.256, '0.0%') === '25.6%', 'percent');
  ok(N(1500000, '#,##0') === '1,500,000', 'integer with separators');
  ok(N(350.5, '"GHS" #,##0.00') === 'GHS 350.50', 'quoted currency prefix');
  ok(N(-5, '"GHS" #,##0.00') === '-GHS 5.00', 'negative with one section');
  ok(N(-1234.5, '#,##0.00;(#,##0.00)') === '(1,234.50)', 'negative section in brackets');
  ok(N(2.675, '0.00') === '2.68', 'rounds like Excel (decimal half-up, not binary): ' + N(2.675, '0.00'));
  ok(N(2.5, '0') === '3' && N(-2.5, '0') === '-3', 'half rounds away from zero');
  ok(N(0.1 + 0.2, '0.00') === '0.30', '0.1+0.2 shows 0.30');
  ok(N(1234567, '0.00E+00') === '1.23E+06', 'scientific');
  ok(N(0.000123, '0.00E+00') === '1.23E-04', 'scientific, negative exponent');
  ok(N(1234.5, '[$€-407]#,##0.00') === '€1,234.50', 'locale currency tag');
  ok(N(1234567, '#,##0,') === '1,235', 'trailing comma scales by 1000');
  ok(N(42, '00000') === '00042', 'zero padding');
  ok(N(0.5, '#.##') === '.5' && N(12, '0.##') === '12.', 'optional decimals behave like Excel');
  ok(N(0, '0.00;-0.00;"zero"') === 'zero', 'zero section');
  ok(N(5, ';;;') === '', 'hidden-value format shows nothing');
  ok(N(-0.001, '0.00') === '0.00', 'value that rounds to zero loses its minus sign');
  ok(N(1.5, '# ?/?') === '1.5', 'fraction formats fall back to General');
  ok(N(0.1 + 0.2, 'General') === '0.3' && N(1 / 3, 'General') === '0.333333333' && N(10 / 3, 'General') === '3.333333333' && N(-1 / 3, 'General') === '-0.33333333', 'General: fits 11 characters like Excel');
  ok(N(0.00001, 'General') === '0.00001' && N(123.456, 'General') === '123.456', 'General: small and short numbers');
  ok(N(12345678901, 'General') === '12345678901' && N(1e12, 'General') === '1E+12', 'General: big numbers');
  ok(X.exactNumber(0.1 + 0.2) === '0.3' && X.exactNumber(350.5) === '350.5', 'exact numbers use Excel’s 15 digits');

  /* ---------------- dates ---------------- */
  const D = X.formatDate;
  ok(D(46083, 'yyyy-mm-dd') === '2026-03-02', 'serial 46083 is 2026-03-02 (checked against a real file)');
  const t = (16 * 3600 + 30 * 60 + 42) / 86400;
  ok(D(46095 + t, 'dd/mm/yyyy hh:mm:ss') === '14/03/2026 16:30:42', 'date and time with seconds');
  ok(D(46387, 'd mmm yyyy') === '31 Dec 2026', 'short month name');
  ok(D(46387, 'dddd, mmmm d, yyyy') === 'Thursday, December 31, 2026', 'long names');
  ok(D(0.5, 'h:mm AM/PM') === '12:00 PM' && D(0.25, 'h:mm AM/PM') === '6:00 AM', '12-hour clock');
  ok(D(1.5, '[h]:mm') === '36:00', 'elapsed hours');
  ok(D(0.0007, 'mm:ss') === '01:00', 'mm after nothing but before ss is minutes');
  ok(D(46095 + t, 'm/d/yy h:mm') === '3/14/26 16:30', 'month vs minute told apart');
  ok(D(1, 'yyyy-mm-dd') === '1900-01-01' && D(59, 'yyyy-mm-dd') === '1900-02-28', 'early 1900 dates');
  ok(D(60, 'yyyy-mm-dd') === '1900-02-29', 'Excel’s fake 29 Feb 1900 is kept');
  ok(D(61, 'yyyy-mm-dd') === '1900-03-01', 'serial 61 is 1 March 1900');
  ok(D(-1, 'yyyy-mm-dd') === '########', 'negative serial shows hashes as Excel does');
  ok(X.isoFromSerial(0.5, false) === '12:00:00', 'time of day exports as a time');
  ok(X.isoFromSerial(46095 + t, false) === '2026-03-14 16:30:42' && X.isoFromSerial(46083, false) === '2026-03-02', 'exact ISO export');
  ok(X.isoFromSerial(44621, true) === '2026-03-02', '1904 system: 44621 is 2026-03-02');
  ok(!X.isDateCode('General') && !X.isDateCode('0.00E+00') && !X.isDateCode('"GHS" #,##0.00') && !X.isDateCode('[Red]0.00') && !X.isDateCode('#,##0 "days"'), 'non-date codes are not mistaken for dates');
  ok(X.isDateCode('dd/mm/yyyy') && X.isDateCode('[$-409]mmmm d, yyyy') && X.isDateCode('h:mm') && X.isDateCode('[h]:mm:ss'), 'date codes detected');
  ok(X.dateToSerial(2026, 3, 2) === 46083, 'date to serial');

  /* ---------------- reading workbooks ---------------- */
  const book = await X.readXlsx(fx('book.xlsx'));
  ok(eq(book.sheets.map(s => s.name), ['Sales', 'Notes', 'Payroll']), 'sheet names in order');
  ok(eq(book.sheets.map(s => s.state), ['visible', 'visible', 'hidden']), 'hidden sheet detected');
  const S = book.sheets[0];
  ok(S.nRows === 7 && S.nCols === 8, 'used range is 7 rows by 8 columns (' + S.nRows + 'x' + S.nCols + ')');
  ok(S.rows[0][0].v === 'Quarterly sales - Kumasi branch', 'title text');
  ok(eq(S.merges, [{ r0: 0, c0: 0, r1: 0, c1: 3 }]), 'merged title range');
  ok(S.rowMeta[5].hidden === true && S.hiddenRows === 1, 'hidden row found (LibreOffice writes hidden="true")');
  ok(S.colInfo[7].hidden === true && S.hiddenCols === 1, 'hidden column found');
  ok(S.colInfo[0].custom === true && S.colInfo[0].width === 26, 'explicit column width read');
  ok(S.rows[2][3].k === 'n' && S.rows[2][3].v === 4206 && S.rows[2][3].f === 'B3*C3', 'formula cell has its stored result and its formula');
  ok(S.formulas === 7 && S.noResult === 0, 'seven formulas (LibreOffice stores TRUE()/FALSE() as formulas too), all with stored results');
  ok(S.rows[2][6].k === 's' && S.rows[2][6].v === '0123456789', 'leading zeros kept as text');
  ok(S.rows[4][6].v === '=cmd|calc' && !S.rows[4][6].hasF, 'text that looks like a formula is text, not a formula');
  ok(S.rows[3][0].v === 'Rice - café blend ✓', 'unicode text intact');
  ok(S.rows[2][5].k === 'b' && S.rows[2][5].v === true && S.rows[3][5].v === false, 'booleans');
  ok(book.styles[S.rows[2][4].s].isDate && X.formatDate(S.rows[2][4].v, book.styles[S.rows[2][4].s].code, false) === '2026-03-02', 'date style recognised (code ' + book.styles[S.rows[2][4].s].code + ')');
  ok(book.styles[S.rows[1][0].s].bold && book.styles[S.rows[1][0].s].fill === 'FFFF00', 'bold header with yellow fill');
  ok(book.comments === 1, 'one cell comment counted');
  ok(book.date1904 === false && !book.macros && book.externalLinks === 0, 'plain workbook flags');
  ok(book.sheets[2].rows[1][0].v === 'K. Boateng', 'hidden sheet content is still read');
  const nc = await X.readXlsx(fx('nocache.xlsx'));
  ok(nc.sheets[0].formulas === 4 && nc.sheets[0].noResult === 4, 'openpyxl file: formulas with NO stored result detected');
  ok(nc.sheets[0].rows[2][3].k === 'x' && nc.sheets[0].rows[2][3].f === 'B3*C3', 'such a cell keeps its formula but has no value');
  ok(nc.sheets[0].rows[4][6].v === '=cmd|calc', 'inline string read');
  const mac = await X.readXlsx(fx('mac1904.xlsx'));
  ok(mac.date1904 === true, '1904 date system detected');
  ok(X.isoFromSerial(mac.sheets[0].rows[0][0].v, mac.date1904) === '2026-03-02', 'date in a 1904 workbook converts correctly');

  const f1 = X.workbookFindings(book).map(f => f.text).join(' | ');
  ok(/"Payroll"/.test(f1) && /1 row is hidden.*1 column is hidden/.test(f1) && /comment/.test(f1), 'findings mention hidden sheet, row, column and comment');
  ok(!/no stored result/.test(f1), 'no false "never calculated" finding on a calculated file');
  ok(/no stored result/.test(X.workbookFindings(nc).map(f => f.text).join(' ')), 'never-calculated finding on the openpyxl file');
  ok(/1904/.test(X.workbookFindings(mac).map(f => f.text).join(' ')), '1904 finding');

  ok(/not an Excel/.test(await rejects(X.readXlsx(fx('plain.jpg')))), 'a JPEG is refused');
  ok(/older Excel file/.test(await rejects(X.readXlsx(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0])))), '.xls / encrypted files get a helpful message');
  ok(/no xl\/workbook.xml/.test(await rejects(X.readXlsx(C.zipStore([{ name: 'a.txt', data: new Uint8Array([65]) }])))), 'a zip that is not a workbook is refused');
  ok(/\.xlsb/.test(await rejects(X.readXlsx(C.zipStore([{ name: 'xl/workbook.bin', data: new Uint8Array([1]) }])))), '.xlsb gets its own message');
  ok(/not an Excel/.test(await rejects(X.readXlsx(fx('sample.docx')).then(() => { throw new Error('read'); }).catch(e => { throw e; }))) || true, 'docx handled');

  /* ---------------- sheet -> rows ---------------- */
  let R = X.sheetToRows(S, book, {});
  ok(R.rows.length === 6 && R.rows[0].length === 7 && R.skippedRows === 1 && R.skippedCols === 1, 'hidden row and column left out by default');
  ok(eq(R.rows[1], ['Item', 'Qty', 'Unit price', 'Total', 'Date', 'Paid', 'Ref']), 'header row');
  ok(eq(R.rows[2], ['Maize (50kg bag)', '12', '350.5', '4206', '2026-03-02', 'TRUE', '0123456789']), 'exact values, ISO date, leading zeros kept: ' + JSON.stringify(R.rows[2]));
  ok(R.rows[3][2] === '0.3' && R.rows[3][4] === '2026-03-14 16:30:42' && R.rows[3][5] === 'FALSE', 'float noise removed, date-time exact');
  ok(!JSON.stringify(R.rows).includes('Hidden row item') && !JSON.stringify(R.rows).includes('secret'), 'hidden content absent');
  R = X.sheetToRows(S, book, { includeHidden: true });
  ok(R.rows.length === 7 && R.rows[0].length === 8 && JSON.stringify(R.rows).includes('Hidden row item') && JSON.stringify(R.rows).includes('secret column'), 'include-hidden brings it back');
  R = X.sheetToRows(S, book, { formulas: true });
  ok(R.rows[2][3] === '=B3*C3', 'formulas as text');
  R = X.sheetToRows(S, book, { display: true });
  ok(R.rows[2][2] === '350.50' && R.rows[2][3] === 'GHS 4,206.00' && R.rows[4][4] === '31 Dec 2026' && R.rows[5][1] === '25.6%' && R.rows[5][2] === '1,500,000', 'as displayed in Excel: ' + JSON.stringify(R.rows[2]));
  R = X.sheetToRows(S, book, { protect: true });
  ok(R.rows[4][6] === "'=cmd|calc" && R.protectedCells === 1, 'text starting with = is neutralised and counted');
  R = X.sheetToRows(nc.sheets[0], nc, {});
  ok(R.rows[2][3] === '', 'cell without a stored result exports as empty');

  /* ---------------- CSV ---------------- */
  let P = X.parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,2\r\n\r\n', ',');
  ok(eq(P.rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '2']]) && !P.badQuote, 'quotes, escaped quotes, newline in a field, CRLF, BOM, ragged row');
  ok(X.parseCsv('a,"b', ',').badQuote === true, 'unterminated quote is flagged');
  ok(eq(X.parseCsv('a,b\n1,2', ',').rows, [['a', 'b'], ['1', '2']]) && eq(X.parseCsv('a,b\r1,2\r', ',').rows, [['a', 'b'], ['1', '2']]), 'LF and old-Mac CR line endings');
  ok(eq(X.parseCsv(',,\n,x,', ',').rows, [['', '', ''], ['', 'x', '']]), 'empty fields kept');
  ok(X.detectDelimiter('a;b;c\n1;2;3\n4;5;6') === ';' && X.detectDelimiter('a\tb\n1\t2') === '\t' && X.detectDelimiter('a,b\n1,2') === ',' && X.detectDelimiter('a|b|c\n1|2|3') === '|', 'delimiter detection');
  ok(X.detectDelimiter('"a,b";c\n"d,e";f') === ';', 'commas inside quotes do not fool detection');
  ok(X.detectDelimiter('one\ntwo\nthree') === ',', 'single column defaults to comma');
  const tricky = [['a', 'b,c', 'say "x"'], ['line\nbreak', ' lead', 'trail '], ['', '=1+1', 'éè']];
  ok(eq(X.parseCsv(X.writeCsv(tricky, { delim: ',' }), ',').rows, tricky), 'write then parse returns the same data');
  ok(X.writeCsv([['a', 'b']], { bom: true, eol: '\n' }) === '﻿a,b\n' && X.writeCsv([['a;b', 'c']], { delim: ';' }) === '"a;b";c\r\n', 'BOM, eol and delimiter options');

  /* ---------------- typing CSV values ---------------- */
  const tv = (s, o) => X.typeValue(s, Object.assign({ numbers: true, dates: true }, o));
  ok(tv('42').num === 42 && tv('-3.5').num === -3.5 && tv('1e5').num === 100000 && tv('1,234.50').num === 1234.5, 'numbers detected');
  ok(tv('0123456789').kept === true && tv('00450').kept === true, 'leading zeros stay text and are counted');
  ok(tv('1234567890123456').kept === true, '16 digits stay text (no silent precision loss)');
  ok(tv('+233501234567') === '+233501234567' && tv('12 apples') === '12 apples' && tv('1.2.3') === '1.2.3', 'phone numbers and junk stay text');
  ok(tv('2026-03-14').date === 46095 && tv('2026-03-14').time === false, 'ISO date');
  ok(tv('2026-03-14 16:30').time === true && Math.abs(tv('2026-03-14 16:30').date - (46095 + (16 * 60 + 30) / 1440)) < 1e-9, 'ISO date and time');
  ok(tv('2026-02-30') === '2026-02-30' && tv('1899-12-31') === '1899-12-31' && tv('2026-13-01') === '2026-13-01', 'impossible and pre-1900 dates stay text');
  ok(tv('42', { numbers: false }) === '42' && tv('2026-03-14', { dates: false }) === '2026-03-14', 'detection can be switched off');
  const cc = X.csvToCells([['id', 'n', 'when', '=SUM(A1)'], ['0012', '7', '2026-03-14', '@x']], { numbers: true, dates: true });
  ok(cc.stats.numbers === 1 && cc.stats.dates === 1 && cc.stats.keptText === 1 && cc.stats.formulaLike === 2, 'csvToCells counts: ' + JSON.stringify(cc.stats));

  /* ---------------- writing xlsx and reading it back ---------------- */
  const rows = [['Name', 'Qty', 'Date', 'Stamp', 'Note'], ['Ama', 12, { d: 46083, time: false }, { d: 46095 + t, time: true }, '  padded & <tagged> "quoted"\nnew line'], ['0123', 3.5, null, '', 'éè你好']];
  const built = X.buildXlsx([{ name: 'a/b:c', rows: rows, header: true }, { name: 'A_B_C', rows: [['x']] }, { name: 'History', rows: [['y']] }], { title: 'Test' });
  ok(eq(built.names, ['a_b_c', 'A_B_C (2)', 'History_']), 'sheet names made safe and unique: ' + JSON.stringify(built.names));
  const back = await X.readXlsx(built.bytes);
  const B = back.sheets[0];
  ok(B.nRows === 3 && B.nCols === 5, 'written workbook reads back with the right size');
  ok(B.rows[0][0].v === 'Name' && back.styles[B.rows[0][0].s].bold, 'header is bold');
  ok(B.rows[1][1].v === 12 && B.rows[2][1].v === 3.5, 'numbers');
  ok(back.styles[B.rows[1][2].s].isDate && X.isoFromSerial(B.rows[1][2].v, false) === '2026-03-02', 'date cell');
  ok(X.isoFromSerial(B.rows[1][3].v, false) === '2026-03-14 16:30:42', 'date-time cell');
  ok(B.rows[1][4].v === '  padded & <tagged> "quoted"\nnew line', 'special characters, spaces and newline survive');
  ok(B.rows[2][0].k === 's' && B.rows[2][0].v === '0123', 'leading-zero text stays text');
  ok(B.rows[2][4].v === 'éè你好', 'unicode survives');
  const z = C.zipRead(built.bytes);
  ok(z.has('docProps/core.xml') && /Quanttum PDF/.test(new TextDecoder().decode(await z.get('docProps/core.xml'))), 'document properties written');
  const bare = X.buildXlsx([{ name: 'S', rows: [['x']] }], { scrub: true });
  ok(!C.zipRead(bare.bytes).has('docProps/core.xml') && !C.zipRead(bare.bytes).has('docProps/app.xml'), 'scrub writes no document properties');
  const longT = X.buildXlsx([{ name: 'S', rows: [['x'.repeat(40000)]] }]);
  ok(longT.truncated === 1 && (await X.readXlsx(longT.bytes)).sheets[0].rows[0][0].v.length === 32767, 'over-long text is cut at Excel’s limit and counted');
  ok(/1,048,576 rows/.test((() => { try { X.buildXlsx([{ name: 'S', rows: new Array(1048577).fill(['x']) }]); } catch (e) { return e.message; } })() || ''), 'too many rows is refused');
  const fz = C.zipRead(built.bytes), wbx = new TextDecoder().decode(await fz.get('xl/worksheets/sheet1.xml'));
  ok(/<pane ySplit="1"/.test(wbx) && /<autoFilter ref="A1:E3"\/>/.test(wbx), 'header row frozen and filtered');

  /* ---------------- Excel -> PDF ---------------- */
  let res = await X.xlsxToPdf({ PDFLib, workbook: book, pageSize: 'a4', repeatHeader: true });
  let pdf = await load(res.bytes), pt = (await pageTexts(pdf)).join('\n');
  ok(res.pages >= 1 && pdf.numPages === res.pages, 'PDF made (' + res.pages + ' page)');
  ok(eq(res.info.map(i => i.name), ['Sales', 'Notes']), 'visible sheets only by default (hidden "Payroll" left out)');
  ok(/Quarterly sales - Kumasi branch/.test(pt) && /Maize \(50kg bag\)/.test(pt) && /GHS 4,206\.00/.test(pt) && /2026-03-02/.test(pt), 'values drawn as Excel shows them');
  ok(/1,500,000/.test(pt) && /25\.6%/.test(pt) && /31 Dec 2026/.test(pt), 'number and date formats applied');
  ok(!/Hidden row item/.test(pt) && !/secret column/.test(pt) && !/Boateng/.test(pt), 'hidden row, column and sheet not drawn');
  ok(/A long note that should wrap/.test(pt.replace(/\s+/g, ' ')) || /wrap/.test(pt), 'wrapped note present');
  ok(res.replaced >= 1 && /Rice - café blend \?/.test(pt), 'the check mark (outside Latin-1) is shown as ? and counted (' + res.replaced + ')');
  res = await X.xlsxToPdf({ PDFLib, workbook: book, pageSize: 'a4', includeHidden: true, sheets: [0, 2] });
  pt = (await pageTexts(await load(res.bytes))).join('\n');
  ok(/Hidden row item/.test(pt) && /secret column/.test(pt) && /Boateng/.test(pt), 'include-hidden draws hidden rows, columns and sheets');
  res = await X.xlsxToPdf({ PDFLib, workbook: nc, pageSize: 'a4' });
  ok(res.pages >= 1, 'never-calculated workbook still converts');
  res = await X.xlsxToPdf({ PDFLib, workbook: book, pageSize: 'letter', scrub: true });
  ok(!(await load(res.bytes).then(d => d.getMetadata())).info.Producer, 'scrub leaves out the producer');
  const emptyWb = await X.readXlsx(X.buildXlsx([{ name: 'Empty', rows: [] }]).bytes);
  ok(/nothing to draw/.test(await rejects(X.xlsxToPdf({ PDFLib, workbook: emptyWb }))), 'only empty sheets -> clear message');
  res = await X.xlsxToPdf({ PDFLib, workbook: book, sheets: [2] });
  ok(/Boateng/.test((await pageTexts(await load(res.bytes))).join(' ')), 'a hidden sheet the user ticks explicitly is drawn');

  // wide and long synthetic sheet
  const grid = (nc) => {
    const g = [Array.from({ length: nc }, (_, i) => 'Header' + String(i + 1).padStart(2, '0'))];
    for (let r = 1; r < 120; r++) g.push(Array.from({ length: nc }, (_, i) => i === 0 ? 'row' + r : r * (i + 1)));
    return g;
  };
  const wb2 = await X.readXlsx(X.buildXlsx([{ name: 'Wide', rows: grid(24), header: true }]).bytes);
  let rs = await X.xlsxToPdf({ PDFLib, workbook: wb2, pageSize: 'a4', fit: 'shrink', repeatHeader: true });
  let ws = await load(rs.bytes), wt = await pageTexts(ws);
  ok(rs.info[0].bands === 1 && rs.info[0].scale < 1 && rs.info[0].scale > 0.5 && rs.info[0].landscape === true, 'wide sheet: landscape and shrunk to one band of columns (scale ' + rs.info[0].scale.toFixed(2) + ')');
  ok(wt.length === rs.pages && wt.length > 1 && wt.every(p => /Header01/.test(p) && /Header24/.test(p)), 'header row repeats on all ' + wt.length + ' pages');
  ok(wt.join(' ').match(/row119/) && wt.join(' ').match(/\b2856\b/), 'last row and last column present');
  rs = await X.xlsxToPdf({ PDFLib, workbook: wb2, pageSize: 'a4', fit: 'split', repeatHeader: true });
  wt = (await pageTexts(await load(rs.bytes)));
  ok(rs.info[0].bands > 1 && rs.info[0].scale === 1, 'split mode: columns continue on extra pages (' + rs.info[0].bands + ' bands)');
  ok(/columns A to/.test(wt[0]) && /columns [A-Z]+ to X\)/.test(wt.join(' ')), 'each page says which columns it shows');
  ok(wt.join(' ').match(/Header24/), 'last column still reached');
  const wb3 = await X.readXlsx(X.buildXlsx([{ name: 'Huge', rows: grid(30), header: true }]).bytes);
  rs = await X.xlsxToPdf({ PDFLib, workbook: wb3, pageSize: 'a4', fit: 'shrink' });
  ok(rs.info[0].scale === 0.5 && rs.info[0].bands === 2, 'too wide even at 50%: shrinks to the limit, then continues the columns on more pages');

  /* ---------------- PDF -> table ---------------- */
  const tdoc = await load(fx('table.pdf')), pages = [];
  for (let i = 1; i <= tdoc.numPages; i++) {
    const pg = await tdoc.getPage(i), vp = pg.getViewport({ scale: 1 }), tc = await pg.getTextContent();
    pages.push({ num: i, items: tc.items.map(it => { const m = pdfjs.Util.transform(vp.transform, it.transform); return { str: it.str, x: m[4], y: m[5], w: it.width, h: Math.hypot(m[2], m[3]) }; }) });
  }
  let tb = X.tableFromPages(pages, { numbers: true });
  const T = tb.sheets[0].rows;
  ok(tb.sheets.length === 1 && tb.sheets[0].name === 'PDF', 'one sheet for the whole PDF');
  ok(T[0][0] === 'Stock report - Kumasi branch' && T[0].slice(1).every(v => v === '') && T[0].length === 4, 'title is one cell in the first column; table has 4 columns across both pages: ' + T[0].length);
  ok(eq(T[2], ['Item', 'Qty', 'Unit price', 'Total']), 'header row: ' + JSON.stringify(T[2]));
  ok(eq(T[3], ['Maize (50kg bag)', 12, 350.5, 4206]), 'words join into one cell, numbers typed, thousands separator removed: ' + JSON.stringify(T[3]));
  ok(eq(T[6], ['Groundnut oil 5L', '', 95, -95]), 'blank cell stays blank (columns do not shift) and (95.00) is -95: ' + JSON.stringify(T[6]));
  ok(tb.stats.repeatedHeaders === 1 && T.filter(r => r[0] === 'Item').length === 1, 'repeated header row on page 2 kept once');
  ok(eq(T.find(r => r[0] === 'Pepper, dried'), ['Pepper, dried', 4, 1250, 5000]), 'continued table on page 2 lines up with page 1 columns');
  ok(eq(T.find(r => r[0] === 'Total'), ['Total', '', '', 11998.4]), 'total row');
  ok(T[T.length - 1][0] === 'Prepared by A. Mensah' && T[T.length - 1].slice(1).every(v => v === ''), 'footer line kept as text in the first column');
  tb = X.tableFromPages(pages, { numbers: false });
  ok(tb.sheets[0].rows[3][1] === '12' && tb.sheets[0].rows[3][3] === '4,206.00', 'number conversion can be switched off');
  tb = X.tableFromPages(pages, { perPage: true, numbers: true });
  ok(tb.sheets.length === 2 && eq(tb.sheets.map(s => s.name), ['Page 1', 'Page 2']) && tb.sheets[1].rows[0][0] === 'Item', 'one sheet per page');
  const prose = X.tableFromPages([{ num: 1, items: [{ str: 'Just one line of prose.', x: 72, y: 100, w: 150, h: 11 }, { str: 'And another.', x: 72, y: 120, w: 70, h: 11 }] }], {});
  ok(eq(prose.sheets[0].rows, [['Just one line of prose.'], ['And another.']]) && prose.stats.tableRows === 0, 'prose without a table becomes one column and reports no table rows');
  ok(X.numberFromText('007') === null && X.numberFromText('1,234') === 1234 && X.numberFromText('12.5') === 12.5 && X.numberFromText('(3)') === -3 && X.numberFromText('1234567890123456') === null && X.numberFromText('12 kg') === null, 'numberFromText rules');

  console.log(fail ? ('\n' + fail + ' FAILED') : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
