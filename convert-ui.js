/* Quanttum PDF - convert-ui.js
 * The Convert view: ten conversions, all on this computer. Vanilla JS, uses converter.js and sheets.js for the logic.
 */
(function () {
  'use strict';

  var C = window.QConvert, Q = window.QSheets, PDFLib = window.PDFLib;
  var pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
  var U = window.QPDF.ui, esc = U.esc;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  Object.assign(U.ICONS, {
    download: 'M10 3v9 M6.5 8.5L10 12l3.5-3.5 M4 16h12',
    up: 'M5 12l5-5 5 5',
    down: 'M5 8l5 5 5-5',
    close: 'M5 5l10 10 M15 5L5 15',
    convert: 'M4 7h11 M12 4l3 3-3 3 M16 13H5 M8 10l-3 3 3 3',
    word: 'M5 2.5h6l4 4v11H5z M11 2.5v4h4 M7.5 10l1 4 1.5-4 1.5 4 1-4',
    lines: 'M4 5h12 M4 9h12 M4 13h8 M4 17h10',
    pdf: 'M5 2.5h6l4 4v11H5z M11 2.5v4h4 M7.5 13.5h5 M7.5 10.5h5',
    sheet: 'M3.5 3.5h13v13h-13z M3.5 8h13 M3.5 12h13 M8 3.5v13',
    inspect: 'M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12.3 12.3l4 4'
  });
  var ic = U.ic;

  var cur = 'img2pdf', built = false;
  var st = { src: null, pages: 0, files: [], busy: false, lastUrl: null, txtName: '', wb: null, csv: null };
  var KIND = {
    image: { icon: 'image', noun: 'images' }, docx: { icon: 'word', noun: 'a Word file' }, pdf: { icon: 'pdf', noun: 'a PDF' },
    xlsx: { icon: 'sheet', noun: 'an Excel file' }, csv: { icon: 'sheet', noun: 'a CSV file' },
    office: { icon: 'inspect', noun: 'a Word, Excel or PowerPoint file' }
  };
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /* ================================================================== */
  /* Small helpers                                                       */
  /* ================================================================== */
  function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  function chkd(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function pad(n, w) { return String(n).padStart(w, '0'); }
  function fld(label, inner) { return '<label class="field"><span>' + label + '</span>' + inner + '</label>'; }
  function sel(id, opts, def) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (String(o[0]) === String(def) ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>';
  }
  function chk(id, label, on) { return '<label class="check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><span>' + label + '</span></label>'; }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }

  function progress(frac, text) {
    var p = $('#cvProgress'); if (!p) return;
    if (frac == null) { p.hidden = true; return; }
    p.hidden = false;
    $('#cvBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    $('#cvProgText').textContent = text || '';
  }

  async function loadPdf(bytes) {
    try {
      return await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/' }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password first, then convert it.');
      throw new Error('This file could not be read as a PDF.');
    }
  }
  async function pageItems(pdf, n) {
    var page = await pdf.getPage(n + 1), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent();
    var items = tc.items.map(function (it) {
      var m = pdfjsLib.Util.transform(vp.transform, it.transform);
      return { str: it.str, x: m[4], y: m[5], w: it.width, h: Math.hypot(m[2], m[3]) };
    });
    var size = { w: vp.width, h: vp.height };
    page.cleanup();
    return { items: items, size: size };
  }

  function mimeOf(kind) { return { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' }[kind]; }
  async function viaCanvas(bytes, inMime, outMime) {
    var bmp;
    try { bmp = await createImageBitmap(new Blob([bytes], { type: inMime }), { imageOrientation: 'from-image' }); }
    catch (e) { throw new Error('The browser could not decode one of the images.'); }
    var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    var ctx = c.getContext('2d');
    if (outMime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    var blob = await new Promise(function (r) { c.toBlob(r, outMime, 0.95); });
    var w = c.width, h = c.height; c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: outMime, w: w, h: h };
  }

  /* ================================================================== */
  /* The ten conversions                                                 */
  /* ================================================================== */
  var NOPDF = 'That file is not a PDF.';
  function checkPdf(bytes) {
    var head = ''; for (var i = 0; i < Math.min(bytes.length, 1024); i++) head += String.fromCharCode(bytes[i]);
    return head.indexOf('%PDF-') >= 0 ? '' : NOPDF;
  }
  function checkDocx(bytes) {
    return (bytes[0] === 0x50 && bytes[1] === 0x4B) ? '' : 'That is not a .docx file. Older .doc files must be re-saved as .docx in Word first.';
  }
  var PAGES_FIELD = fld('Pages', '<input type="text" id="cvPages" placeholder="all, or e.g. 1-3, 5, 8-" spellcheck="false">');

  var T = {
    img2pdf: {
      title: 'Images to PDF', sub: 'JPG, PNG, WebP, GIF, BMP', icon: 'image', kind: 'image', multi: true, accept: 'image/*', action: 'Create PDF',
      blurb: 'Turn photos and scans into one PDF, one image per page. Use the arrows to change the page order.',
      note: 'Photos can carry hidden camera, date and GPS location data, and a PDF built from the original file carries it too. By default it is removed from JPEGs without re-compressing the picture.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Page size', sel('cvPageSize', [['a4', 'A4'], ['letter', 'US Letter'], ['fit', 'Same size as each image']], 'a4')) +
          fld('Margin', sel('cvMargin', [['0', 'None'], ['18', 'Small'], ['36', 'Normal']], '18')) + '</div>' +
          chk('cvStrip', 'Remove photo metadata (camera, date, GPS location)', true) +
          chk('cvScrub', 'Leave document properties out of the PDF (no producer, no dates)', false);
      },
      run: runImg2Pdf
    },
    txt2pdf: {
      title: 'Text to PDF', sub: 'Paste text or open a .txt file', icon: 'lines', kind: 'text', accept: '.txt,text/plain', action: 'Create PDF',
      blurb: 'Paste text or open a plain text file and get a clean, paginated PDF.',
      note: 'Uses standard PDF fonts, so Latin characters only. Other characters appear as ? and are counted for you. A form-feed character in the text starts a new page.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Font', sel('cvFont', [['Helvetica', 'Sans-serif (Helvetica)'], ['Times', 'Serif (Times)'], ['Courier', 'Monospace (Courier)']], 'Helvetica')) +
          fld('Size', sel('cvSize', [['9', '9 pt'], ['10', '10 pt'], ['11', '11 pt'], ['12', '12 pt'], ['14', '14 pt']], '11')) +
          fld('Page size', sel('cvPageSize', [['a4', 'A4'], ['letter', 'US Letter']], 'a4')) +
          fld('Margin', sel('cvMargin', [['36', 'Narrow'], ['54', 'Normal'], ['72', 'Wide']], '54')) + '</div>' +
          chk('cvPN', 'Number the pages', true) +
          chk('cvScrub', 'Leave document properties out of the PDF (no producer, no dates)', false);
      },
      run: runTxt2Pdf
    },
    doc2pdf: {
      title: 'Word to PDF', sub: '.docx, text only', icon: 'word', kind: 'docx', accept: '.docx', action: 'Create PDF',
      blurb: 'Make a PDF from the text, headings, bullet lists and tables of a Word (.docx) file.',
      note: 'This is a text copy, not a pixel-perfect print. Pictures, headers, footers, numbering and Word fonts are not reproduced. For an exact layout, print to PDF from Word itself.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Page size', sel('cvPageSize', [['a4', 'A4'], ['letter', 'US Letter']], 'a4')) +
          fld('Font', sel('cvFont', [['Helvetica', 'Sans-serif (Helvetica)'], ['Times', 'Serif (Times)']], 'Helvetica')) +
          fld('Text size', sel('cvSize', [['10', '10 pt'], ['11', '11 pt'], ['12', '12 pt']], '11')) +
          fld('Margin', sel('cvMargin', [['54', 'Narrow'], ['72', 'Normal (1 inch)'], ['90', 'Wide']], '72')) + '</div>' +
          chk('cvScrub', 'Leave document properties out of the PDF (no producer, no dates)', false);
      },
      run: runDoc2Pdf
    },
    pdf2img: {
      title: 'PDF to images', sub: 'PNG or JPG, any pages', icon: 'image', kind: 'pdf', accept: 'application/pdf,.pdf', action: 'Create images',
      blurb: 'Save pages of a PDF as pictures. One page gives one image, several pages give a zip file.',
      note: 'Each page is drawn exactly as it appears. The images contain no text layer, so they cannot be searched or selected.',
      options: function () {
        return '<div class="cv-grid">' + PAGES_FIELD +
          fld('Format', sel('cvFormat', [['png', 'PNG (sharp, larger)'], ['jpg', 'JPG (smaller)']], 'png')) +
          fld('Resolution', sel('cvDpi', [['72', '72 dpi (screen)'], ['110', '110 dpi'], ['150', '150 dpi (good)'], ['200', '200 dpi'], ['300', '300 dpi (print)']], '150')) +
          fld('JPG quality', sel('cvQuality', [['70', 'Smaller file'], ['85', 'Balanced'], ['92', 'Best']], '92')) + '</div>';
      },
      run: runPdf2Img
    },
    pdf2txt: {
      title: 'PDF to text', sub: 'Plain .txt, any pages', icon: 'lines', kind: 'pdf', accept: 'application/pdf,.pdf', action: 'Extract text',
      blurb: 'Pull the text out of a PDF into a plain text file.',
      note: 'Only text that is actually stored in the PDF can be extracted. Scanned pages are pictures and need OCR, which is not included. Multi-column pages may read across the columns.',
      options: function () {
        return '<div class="cv-grid">' + PAGES_FIELD +
          fld('Line breaks', sel('cvMode', [['paragraphs', 'Join lines into paragraphs'], ['lines', 'Keep the PDF\u2019s line breaks']], 'paragraphs')) + '</div>' +
          chk('cvMark', 'Mark where each page starts', true);
      },
      run: runPdf2Txt
    },
    pdf2doc: {
      title: 'PDF to Word', sub: 'Editable .docx, text only', icon: 'word', kind: 'pdf', accept: 'application/pdf,.pdf', action: 'Create Word file',
      blurb: 'Rebuild the text of a PDF as an editable Word (.docx) document.',
      note: 'The Word file is rebuilt from the text on each page: headings and paragraphs are detected from font size and spacing. Columns, tables, pictures and exact fonts are not reproduced. Scanned pages have no text and come out blank.',
      options: function () {
        return '<div class="cv-grid">' + PAGES_FIELD + '</div>' + chk('cvBreaks', 'Start each PDF page on a new page', true);
      },
      run: runPdf2Doc
    },
    xls2pdf: {
      title: 'Excel to PDF', sub: '.xlsx, values as shown', icon: 'sheet', kind: 'xlsx', accept: '.xlsx,.xlsm', action: 'Create PDF',
      blurb: 'Print the sheets of an Excel workbook to a PDF, with the numbers and dates formatted the way Excel shows them.',
      note: 'This is a clean table print, not a copy of Excel’s page layout. Text, number formats, bold, alignment, fills, wrapping and column widths are kept. Theme colours, borders, charts, pictures and conditional formatting are not. Standard fonts only, so Latin characters only.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Page size', sel('cvPageSize', [['a4', 'A4'], ['letter', 'US Letter']], 'a4')) +
          fld('Orientation', sel('cvOrient', [['auto', 'Automatic (best fit per sheet)'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], 'auto')) +
          fld('Wide sheets', sel('cvFit', [['shrink', 'Shrink to fit the page width'], ['split', 'Keep full size, continue on more pages']], 'shrink')) +
          fld('Text size', sel('cvSize', [['7', '7 pt'], ['8', '8 pt'], ['9', '9 pt'], ['10', '10 pt'], ['11', '11 pt']], '9')) +
          fld('Margin', sel('cvMargin', [['18', 'Small'], ['36', 'Normal'], ['54', 'Wide']], '36')) + '</div>' +
          chk('cvGrid', 'Draw grid lines', true) +
          chk('cvRepeat', 'Repeat the first row at the top of every page', true) +
          chk('cvHidden', 'Include hidden rows and columns (left out by default)', false) +
          chk('cvScrub', 'Leave document properties out of the PDF (no producer, no dates)', false);
      },
      run: runXls2Pdf
    },
    xls2csv: {
      title: 'Excel to CSV', sub: 'One CSV per sheet', icon: 'sheet', kind: 'xlsx', accept: '.xlsx,.xlsm', action: 'Create CSV',
      blurb: 'Export the sheets of an Excel workbook as plain CSV text. One sheet gives a .csv file, several give a zip.',
      note: 'CSV holds values only: no formatting, formulas (unless you ask for them as text), colours or comments. Files are written as UTF-8 so accented letters survive.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Separator', sel('cvDelim', [[',', 'Comma ( , )'], [';', 'Semicolon ( ; ) for European Excel'], ['\t', 'Tab'], ['|', 'Pipe ( | )']], ',')) +
          fld('Numbers and dates', sel('cvValues', [['exact', 'Exact values (dates as 2026-03-14)'], ['display', 'As shown in Excel (formatting applied)']], 'exact')) + '</div>' +
          chk('cvBom', 'Add a UTF-8 byte-order mark (helps older Excel open accented text correctly)', false) +
          chk('cvProtect', 'Protect against formula injection (a cell that starts with = + - @ gets a leading apostrophe)', true) +
          chk('cvFormulas', 'Write formulas as text, like =SUM(B2:B9), instead of their results', false) +
          chk('cvHidden', 'Include hidden rows and columns (left out by default)', false);
      },
      run: runXls2Csv
    },
    csv2xls: {
      title: 'CSV to Excel', sub: 'CSV, TSV or delimited text', icon: 'sheet', kind: 'csv', accept: '.csv,.tsv,.txt,text/csv,text/plain', action: 'Create Excel file',
      blurb: 'Turn a CSV file into an .xlsx workbook with real numbers and dates.',
      note: 'Cells are never turned into formulas, even if they begin with =. Values with leading zeros (0123), plus signs or more than 15 digits stay as text so nothing is silently changed. Dates are only recognised in the unambiguous year-month-day form.',
      options: function () {
        return '<div class="cv-grid">' +
          fld('Separator', sel('cvDelim', [['auto', 'Detect automatically'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']], 'auto')) +
          fld('Sheet name', '<input type="text" id="cvSheetName" placeholder="Same as the file name" spellcheck="false" maxlength="31">') + '</div>' +
          chk('cvNums', 'Turn numbers into real numbers (1,234.50 becomes 1234.5)', true) +
          chk('cvDates', 'Turn dates like 2026-03-14 into real Excel dates', true) +
          chk('cvHeader', 'Treat the first row as a header (bold, frozen, with a filter)', true) +
          chk('cvScrub', 'Leave document properties out of the workbook (no creator, no dates)', false);
      },
      run: runCsv2Xls
    },
    pdf2xls: {
      title: 'PDF to Excel', sub: 'Tables, best effort', icon: 'sheet', kind: 'pdf', accept: 'application/pdf,.pdf', action: 'Create Excel file',
      blurb: 'Find tables in a PDF and put them in an Excel workbook, one row per line, one column per column of figures.',
      note: 'Columns are found from the gaps in the text, so it works on text-based PDFs with clear columns. Scanned pages need OCR, which is not included. Merged cells, ruled lines and tables without gaps may split wrongly, so always check the result against the PDF.',
      options: function () {
        return '<div class="cv-grid">' + PAGES_FIELD +
          fld('Sheets', sel('cvLayout', [['one', 'One sheet for the whole table'], ['pages', 'One sheet per page']], 'one')) + '</div>' +
          chk('cvNums', 'Turn figures like 1,250.00 and (95.00) into real numbers', true) +
          chk('cvHeader', 'Style the first row as a header (bold, frozen, with a filter)', false) +
          chk('cvScrub', 'Leave document properties out of the workbook (no creator, no dates)', false);
      },
      run: runPdf2Xls    },
    inspect: {
      title: 'Inspect an Office file', sub: 'Authors, changes, hidden content', icon: 'inspect', kind: 'office', accept: '.docx,.docm,.xlsx,.xlsm,.pptx,.pptm', action: 'Inspect file',
      blurb: 'See what a Word, Excel or PowerPoint file holds that the program would not show you: who handled it, tracked changes and the text they deleted, hidden text, sheets and slides, comments, speaker notes and leftover data.',
      note: 'The file is read as the zip of XML parts it is. Nothing is opened in Office and no macro runs. Findings are prompts for a closer look, not verdicts, and file properties can be set to anything. Only the modern .docx, .xlsx and .pptx formats are supported.',
      options: null,
      run: runInspect
    }
  };

  /* ---------- Images -> PDF ---------- */
  async function runImg2Pdf() {
    var strip = chkd('cvStrip'), n = st.files.length, images = [], rotated = 0, converted = 0, strippedN = 0, gpsStripped = 0, gpsKept = 0, i;
    for (i = 0; i < n; i++) {
      progress(i / n, 'Reading image ' + (i + 1) + ' of ' + n);
      await tick();
      var f = st.files[i], bytes = new Uint8Array(await f.file.arrayBuffer()), kind = C.sniffImage(bytes), img;
      if (kind === 'heic') throw new Error(f.name + ' is a HEIC photo. Browsers cannot decode HEIC. Share or export it as JPEG from your phone and try again.');
      if (kind === 'unknown') throw new Error(f.name + ' is not a supported image. Use JPG, PNG, WebP, GIF, BMP or AVIF.');
      if (kind === 'jpeg') {
        var info = C.jpegInfo(bytes);
        if (!info.valid) throw new Error(f.name + ' looks damaged (it is not a readable JPEG).');
        if (info.orientation > 1) {
          img = await viaCanvas(bytes, 'image/jpeg', 'image/jpeg'); rotated++;
          if (info.hasExif || info.hasXmp || info.hasOther) strippedN++;
          if (info.hasGps) gpsStripped++;
        } else if (strip) {
          var s = C.stripJpegMetadata(bytes);
          img = { bytes: s.bytes, mime: 'image/jpeg', w: info.width, h: info.height };
          if (s.removed.length) { strippedN++; if (info.hasGps) gpsStripped++; }
        } else {
          img = { bytes: bytes, mime: 'image/jpeg', w: info.width, h: info.height };
          if (info.hasGps) gpsKept++;
        }
      } else if (kind === 'png') {
        var sz = C.pngSize(bytes); img = { bytes: bytes, mime: 'image/png', w: sz.width, h: sz.height };
      } else {
        img = await viaCanvas(bytes, mimeOf(kind), 'image/png'); converted++;
      }
      images.push(img);
    }
    progress(0.95, 'Building the PDF');
    await tick();
    var res = await C.imagesToPdf({
      PDFLib: PDFLib, images: images, pageSize: val('cvPageSize'), margin: +val('cvMargin'), scrub: chkd('cvScrub'),
      reencode: function (im) { return viaCanvas(im.bytes, im.mime, 'image/png'); }
    });
    var notes = [];
    if (strippedN) notes.push({ level: 'info', text: 'Removed camera, date and other hidden data from ' + plural(strippedN, 'photo', 'photos') + (gpsStripped ? ', including the GPS location of ' + gpsStripped + '.' : '.') });
    if (gpsKept) notes.push({ level: 'warn', text: plural(gpsKept, 'photo carries', 'photos carry') + ' GPS location data, and it is now stored inside the PDF. Turn on metadata removal and convert again if you do not want to share it.' });
    if (rotated) notes.push({ level: 'info', text: plural(rotated, 'photo was', 'photos were') + ' rotated upright and re-encoded. Re-encoding drops all hidden data.' });
    if (converted) notes.push({ level: 'info', text: plural(converted, 'image was', 'images were') + ' converted to PNG first (WebP, GIF, BMP and AVIF are not stored directly in PDFs).' });
    return {
      name: (n === 1 ? C.safeBase(st.files[0].name) : 'images') + '.pdf', bytes: res.bytes, mime: 'application/pdf',
      summary: plural(res.pages, 'page', 'pages') + ' created from ' + plural(n, 'image', 'images') + '.', notes: notes
    };
  }

  /* ---------- Text -> PDF ---------- */
  async function runTxt2Pdf() {
    progress(0.3, 'Laying out the text'); await tick();
    var res = await C.textToPdf({
      PDFLib: PDFLib, text: val('cvText'), font: val('cvFont'), size: +val('cvSize'), pageSize: val('cvPageSize'),
      margin: +val('cvMargin'), pageNumbers: chkd('cvPN'), scrub: chkd('cvScrub')
    });
    var notes = [];
    if (res.replaced) notes.push({ level: 'warn', text: plural(res.replaced, 'character', 'characters') + ' outside the Latin alphabet could not be drawn and appear as ?.' });
    return { name: (st.txtName ? C.safeBase(st.txtName) : 'text') + '.pdf', bytes: res.bytes, mime: 'application/pdf', summary: plural(res.pages, 'page', 'pages') + ' created.', notes: notes };
  }

  /* ---------- Word -> PDF ---------- */
  async function runDoc2Pdf() {
    progress(0.2, 'Reading the Word file'); await tick();
    var doc = await C.readDocx(st.src.bytes);
    progress(0.6, 'Laying out the pages'); await tick();
    var res = await C.docxToPdf({
      PDFLib: PDFLib, blocks: doc.blocks, font: val('cvFont'), size: +val('cvSize'), pageSize: val('cvPageSize'),
      margin: +val('cvMargin'), scrub: chkd('cvScrub')
    });
    var notes = [], s = doc.stats;
    if (s.pictures) notes.push({ level: 'warn', text: plural(s.pictures, 'picture or drawing is', 'pictures or drawings are') + ' not carried over.' });
    if (res.replaced) notes.push({ level: 'warn', text: plural(res.replaced, 'character', 'characters') + ' outside the Latin alphabet could not be drawn and appear as ?.' });
    if (s.hasHeaderFooter) notes.push({ level: 'info', text: 'Headers and footers are not carried over.' });
    if (s.tables) notes.push({ level: 'info', text: plural(s.tables, 'table was', 'tables were') + ' drawn with equal-width columns.' });
    return { name: C.safeBase(st.src.name) + '.pdf', bytes: res.bytes, mime: 'application/pdf', summary: plural(res.pages, 'page', 'pages') + ' created.', notes: notes };
  }

  /* ---------- PDF -> images ---------- */
  async function runPdf2Img() {
    var pdf = await loadPdf(st.src.bytes), rg = C.parseRanges(val('cvPages'), pdf.numPages);
    if (rg.error) { pdf.destroy(); throw new Error(rg.error); }
    var fmt = val('cvFormat'), dpi = +val('cvDpi'), q = +val('cvQuality') / 100;
    var mime = fmt === 'png' ? 'image/png' : 'image/jpeg', ext = fmt === 'png' ? 'png' : 'jpg';
    var base = C.safeBase(st.src.name), files = [], capped = 0, MAXPX = 36e6;
    try {
      for (var i = 0; i < rg.pages.length; i++) {
        var n = rg.pages[i];
        progress(i / rg.pages.length, 'Drawing page ' + (n + 1) + ' (' + (i + 1) + ' of ' + rg.pages.length + ')');
        await tick();
        var page = await pdf.getPage(n + 1), scale = dpi / 72, vp = page.getViewport({ scale: scale });
        if (vp.width * vp.height > MAXPX) { scale *= Math.sqrt(MAXPX / (vp.width * vp.height)); vp = page.getViewport({ scale: scale }); capped++; }
        var c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        var blob = await new Promise(function (r) { c.toBlob(r, mime, q); });
        files.push({ name: base + '-page-' + pad(n + 1, Math.max(3, String(pdf.numPages).length)) + '.' + ext, data: new Uint8Array(await blob.arrayBuffer()) });
        c.width = c.height = 0; page.cleanup();
      }
    } finally { pdf.destroy(); }
    var notes = [];
    if (capped) notes.push({ level: 'warn', text: plural(capped, 'page was', 'pages were') + ' very large and drawn at a lower resolution to stay within the browser\u2019s memory limits.' });
    if (files.length === 1) return { name: files[0].name, bytes: files[0].data, mime: mime, summary: '1 image created.', notes: notes };
    return { name: base + '-images.zip', bytes: C.zipStore(files), mime: 'application/zip', summary: plural(files.length, 'image', 'images') + ' created and packed in a zip file.', notes: notes };
  }

  /* ---------- PDF -> text / Word share the extraction ---------- */
  async function extract(withSize) {
    var pdf = await loadPdf(st.src.bytes), rg = C.parseRanges(val('cvPages'), pdf.numPages);
    if (rg.error) { pdf.destroy(); throw new Error(rg.error); }
    var pages = [], size = null;
    try {
      for (var i = 0; i < rg.pages.length; i++) {
        progress(i / rg.pages.length, 'Reading page ' + (rg.pages[i] + 1) + ' (' + (i + 1) + ' of ' + rg.pages.length + ')');
        if (i % 4 === 0) await tick();
        var r = await pageItems(pdf, rg.pages[i]);
        if (!size) size = r.size;
        pages.push({ num: rg.pages[i] + 1, lines: C.layoutLines(r.items) });
      }
    } finally { pdf.destroy(); }
    var chars = 0, empty = 0;
    pages.forEach(function (p) { var c = p.lines.reduce(function (a, l) { return a + l.text.length; }, 0); chars += c; if (!c) empty++; });
    if (!chars) throw new Error('This PDF has no selectable text. It is probably a scan or made of pictures. OCR (reading text from images) is not included in Quanttum PDF.');
    return { pages: pages, size: size, empty: empty };
  }

  async function runPdf2Txt() {
    var ex = await extract();
    var text = C.textFromPages(ex.pages, { mode: val('cvMode'), mark: chkd('cvMark') });
    var words = (text.match(/\S+/g) || []).length, notes = [];
    if (ex.empty) notes.push({ level: 'warn', text: plural(ex.empty, 'page has', 'pages have') + ' no selectable text (scanned or picture-only) and appear empty.' });
    return {
      name: C.safeBase(st.src.name) + '.txt', bytes: new TextEncoder().encode(text), mime: 'text/plain',
      summary: plural(words, 'word', 'words') + ' from ' + plural(ex.pages.length, 'page', 'pages') + '.', notes: notes,
      preview: text.length > 1500 ? text.slice(0, 1500) + '\n\u2026' : text
    };
  }

  async function runPdf2Doc() {
    var ex = await extract(), paras = [], brk = chkd('cvBreaks');
    ex.pages.forEach(function (pg, i) {
      var ps = C.toParagraphs(pg.lines), first = true;
      if (!ps.length && brk && i > 0) paras.push({ text: '', kind: 'p', pageBreakBefore: true });
      ps.forEach(function (p) { paras.push({ text: p.text, kind: p.kind, pageBreakBefore: brk && i > 0 && first }); first = false; });
    });
    var bytes = C.buildDocx(paras, { pageW: ex.size.w, pageH: ex.size.h }), notes = [];
    if (ex.empty) notes.push({ level: 'warn', text: plural(ex.empty, 'page has', 'pages have') + ' no selectable text (scanned or picture-only) and come out blank.' });
    var head = paras.filter(function (p) { return /^h[123]$/.test(p.kind); }).length;
    return {
      name: C.safeBase(st.src.name) + '.docx', bytes: bytes, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      summary: plural(paras.length, 'paragraph', 'paragraphs') + ' (' + plural(head, 'heading', 'headings') + ') from ' + plural(ex.pages.length, 'page', 'pages') + '.', notes: notes
    };
  }

  /* ---------- Spreadsheet conversions ---------- */
  function selectedSheets() { return $$('.cv-sheet').filter(function (b) { return b.checked; }).map(function (b) { return +b.dataset.i; }); }
  function fileNameSafe(s) { return String(s).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'sheet'; }
  function previewRows(rows, n) {
    return rows.slice(0, n).map(function (r) { return r.map(function (v) { return v && typeof v === 'object' ? Q.isoFromSerial(v.d, false) : v == null ? '' : String(v); }).join('  |  '); }).join('\n') + (rows.length > n ? '\n…' : '');
  }

  async function runXls2Pdf() {
    var idx = selectedSheets(), wb = st.wb;
    if (!idx.length) throw new Error('Tick at least one sheet to convert.');
    var hid = chkd('cvHidden'), base = C.safeBase(st.src.name);
    progress(0.05, 'Laying out the sheets'); await tick();
    var res = await Q.xlsxToPdf({
      PDFLib: PDFLib, workbook: wb, sheets: idx, includeHidden: hid, orientation: val('cvOrient'), pageSize: val('cvPageSize'),
      margin: +val('cvMargin'), fit: val('cvFit'), fontSize: +val('cvSize'), gridlines: chkd('cvGrid'), repeatHeader: chkd('cvRepeat'),
      scrub: chkd('cvScrub'), title: base, onProgress: function (f, name) { progress(0.05 + 0.9 * f, 'Drawing "' + name + '"'); }
    });
    var notes = [];
    if (res.replaced) notes.push({ level: 'warn', text: plural(res.replaced, 'character', 'characters') + ' outside the Latin alphabet could not be drawn and appear as ?.' });
    if (res.skipped.length) notes.push({ level: 'info', text: 'Nothing to draw on ' + res.skipped.map(function (n) { return '"' + n + '"'; }).join(', ') + ' (empty, or everything on it is hidden).' });
    res.info.forEach(function (i) { if (i.bands > 1) notes.push({ level: 'info', text: '"' + i.name + '" is wider than one page, so its columns continue on ' + plural(i.bands - 1, 'extra set of pages', 'extra sets of pages') + '.' }); });
    if (!hid) {
      var hr = 0, hc = 0; idx.forEach(function (i) { hr += wb.sheets[i].hiddenRows; hc += wb.sheets[i].hiddenCols; });
      if (hr || hc) notes.push({ level: 'warn', text: 'Left out of the PDF: ' + [hr ? plural(hr, 'hidden row', 'hidden rows') : '', hc ? plural(hc, 'hidden column', 'hidden columns') : ''].filter(Boolean).join(' and ') + '. Tick “Include hidden rows and columns” to print them.' });
    }
    var nr = idx.reduce(function (a, i) { return a + wb.sheets[i].noResult; }, 0);
    if (nr) notes.push({ level: 'warn', text: plural(nr, 'formula has', 'formulas have') + ' no stored result (the file was never calculated in Excel), so those cells are blank in the PDF.' });
    if (!res.pages) throw new Error('There was nothing to draw: the selected sheets are empty.');
    return { name: base + '.pdf', bytes: res.bytes, mime: 'application/pdf', summary: plural(res.pages, 'page', 'pages') + ' created from ' + plural(idx.length - res.skipped.length, 'sheet', 'sheets') + '.', notes: notes };
  }

  async function runXls2Csv() {
    var idx = selectedSheets(), wb = st.wb;
    if (!idx.length) throw new Error('Tick at least one sheet to convert.');
    var delim = val('cvDelim'), bom = chkd('cvBom'), files = [], used = {}, notes = [], skippedR = 0, skippedC = 0, prot = 0, base = C.safeBase(st.src.name), first = '', empty = [];
    for (var k = 0; k < idx.length; k++) {
      var sh = wb.sheets[idx[k]];
      progress(k / idx.length, 'Writing "' + sh.name + '"'); await tick();
      var r = Q.sheetToRows(sh, wb, { includeHidden: chkd('cvHidden'), formulas: chkd('cvFormulas'), display: val('cvValues') === 'display', protect: chkd('cvProtect') });
      skippedR += r.skippedRows; skippedC += r.skippedCols; prot += r.protectedCells;
      if (!r.rows.length) { empty.push(sh.name); continue; }
      var text = Q.writeCsv(r.rows, { delim: delim, bom: bom });
      if (!first) first = text;
      var nm = fileNameSafe(sh.name), key = nm.toLowerCase(), n = 2, uniq = nm;
      while (used[key]) { uniq = nm + '-' + n; key = uniq.toLowerCase(); n++; }
      used[key] = 1;
      files.push({ name: base + '-' + uniq + '.csv', data: new TextEncoder().encode(text), rows: r.rows.length });
    }
    if (empty.length) notes.push({ level: 'info', text: 'Skipped empty ' + (empty.length === 1 ? 'sheet' : 'sheets') + ': ' + empty.map(function (e) { return '"' + e + '"'; }).join(', ') + '.' });
    if (!files.length) throw new Error('There was nothing to export: the selected sheets are empty.');
    if (skippedR || skippedC) notes.push({ level: 'warn', text: 'Left out of the CSV: ' + [skippedR ? plural(skippedR, 'hidden row', 'hidden rows') : '', skippedC ? plural(skippedC, 'hidden column', 'hidden columns') : ''].filter(Boolean).join(' and ') + '.' });
    if (prot) notes.push({ level: 'info', text: plural(prot, 'text cell', 'text cells') + ' began with = + - or @ and got a leading apostrophe so a spreadsheet will not run them as formulas.' });
    var nr = idx.reduce(function (a, i) { return a + wb.sheets[i].noResult; }, 0);
    if (nr && !chkd('cvFormulas')) notes.push({ level: 'warn', text: plural(nr, 'formula has', 'formulas have') + ' no stored result (never calculated in Excel), so those cells are empty in the CSV.' });
    if (delim === ',' && val('cvValues') === 'display') notes.push({ level: 'info', text: 'Values are written as Excel shows them, so thousands separators such as 1,250.00 are quoted. Use exact values if another program will read the numbers.' });
    var total = files.reduce(function (a, f) { return a + f.rows; }, 0), shown = first.replace(/^﻿/, '');
    if (files.length === 1) {
      return { name: files[0].name, bytes: files[0].data, mime: 'text/csv', summary: plural(files[0].rows, 'row', 'rows') + ' exported.', notes: notes, preview: shown.length > 1500 ? shown.slice(0, 1500) + '\n…' : shown };
    }
    return {
      name: base + '-csv.zip', bytes: C.zipStore(files.map(function (f) { return { name: f.name, data: f.data }; })), mime: 'application/zip',
      summary: plural(total, 'row', 'rows') + ' exported to ' + plural(files.length, 'CSV file', 'CSV files') + ', packed in a zip file.', notes: notes
    };
  }

  async function runCsv2Xls() {
    var csv = st.csv, delim = val('cvDelim') === 'auto' ? csv.delim : val('cvDelim');
    progress(0.2, 'Reading the CSV'); await tick();
    var parsed = Q.parseCsv(csv.text, delim), notes = [];
    if (!parsed.rows.length) throw new Error('The file has no rows.');
    progress(0.5, 'Typing the cells'); await tick();
    var cells = Q.csvToCells(parsed.rows, { numbers: chkd('cvNums'), dates: chkd('cvDates') }), s = cells.stats;
    progress(0.8, 'Building the workbook'); await tick();
    var base = C.safeBase(st.src.name), nm = val('cvSheetName').trim() || base;
    var res = Q.buildXlsx([{ name: nm, rows: cells.rows, header: chkd('cvHeader') }], { scrub: chkd('cvScrub'), title: base });
    var cols = parsed.rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0);
    notes.push({ level: 'info', text: 'Separator used: ' + ({ ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delim]) + '.' });
    if (csv.enc !== 'UTF-8') notes.push({ level: 'warn', text: 'The file is not valid UTF-8, so it was read as ' + csv.enc + '. Check accented letters and symbols in the result.' });
    if (parsed.badQuote) notes.push({ level: 'warn', text: 'A quoted value was never closed. Everything after it was read as part of that value, so check the end of the file.' });
    if (s.numbers || s.dates) notes.push({ level: 'info', text: [s.numbers ? plural(s.numbers, 'number', 'numbers') : '', s.dates ? plural(s.dates, 'date', 'dates') : ''].filter(Boolean).join(' and ') + ' became real Excel values.' });
    if (s.keptText) notes.push({ level: 'info', text: plural(s.keptText, 'value was', 'values were') + ' kept as text because converting it could change it (leading zeros, or more than 15 digits).' });
    if (s.formulaLike) notes.push({ level: 'warn', text: plural(s.formulaLike, 'cell starts', 'cells start') + ' with = + - or @. They are stored as plain text and will never run as formulas.' });
    var dec = 0; cells.rows.forEach(function (r) { r.forEach(function (v) { if (typeof v === 'string' && /^-?\d{1,15},\d{1,2}$/.test(v.trim()) && delim !== ',') dec++; }); });
    if (dec && chkd('cvNums')) notes.push({ level: 'warn', text: plural(dec, 'value looks', 'values look') + ' like a number with a decimal comma (1234,5). It is ambiguous, so it was kept as text rather than guessed. Convert it in Excel if that is what it means.' });
    var w0 = parsed.rows[0].length, ragged = parsed.rows.filter(function (r) { return r.length !== w0; }).length;
    if (ragged) notes.push({ level: 'warn', text: plural(ragged, 'row has', 'rows have') + ' a different number of columns from the first row. Check that the separator is right.' });
    if (res.truncated) notes.push({ level: 'warn', text: plural(res.truncated, 'cell was', 'cells were') + ' longer than Excel’s 32,767 character limit and was cut.' });
    return {
      name: base + '.xlsx', bytes: res.bytes, mime: XLSX_MIME, notes: notes, preview: previewRows(cells.rows, 12),
      summary: plural(parsed.rows.length, 'row', 'rows') + ' and ' + plural(cols, 'column', 'columns') + ' written to the sheet “' + res.names[0] + '”.'
    };
  }

  async function runPdf2Xls() {
    var pdf = await loadPdf(st.src.bytes), rg = C.parseRanges(val('cvPages'), pdf.numPages);
    if (rg.error) { pdf.destroy(); throw new Error(rg.error); }
    var pages = [], chars = 0, i;
    try {
      for (i = 0; i < rg.pages.length; i++) {
        progress(i / rg.pages.length * 0.8, 'Reading page ' + (rg.pages[i] + 1) + ' (' + (i + 1) + ' of ' + rg.pages.length + ')');
        if (i % 4 === 0) await tick();
        var r = await pageItems(pdf, rg.pages[i]);
        r.items.forEach(function (it) { chars += it.str.trim().length; });
        pages.push({ num: rg.pages[i] + 1, items: r.items });
      }
    } finally { pdf.destroy(); }
    if (!chars) throw new Error('This PDF has no selectable text. It is probably a scan or made of pictures. OCR (reading text from images) is not included in Quanttum PDF.');
    progress(0.85, 'Finding the columns'); await tick();
    var t = Q.tableFromPages(pages, { perPage: val('cvLayout') === 'pages', numbers: chkd('cvNums') }), hdr = chkd('cvHeader');
    var sheets = t.sheets.filter(function (s) { return s.rows.length; });
    if (!sheets.length) throw new Error('No text could be arranged into rows on the selected pages.');
    sheets.forEach(function (s) { s.header = hdr; });
    var res = Q.buildXlsx(sheets, { scrub: chkd('cvScrub'), title: C.safeBase(st.src.name) }), s = t.stats, notes = [];
    var rowsN = sheets.reduce(function (a, x) { return a + x.rows.length; }, 0);
    if (!s.tableRows) notes.push({ level: 'warn', text: 'No table with two or more columns was found, so every line is in the first column. Try “PDF to text” if this is ordinary prose.' });
    else notes.push({ level: 'info', text: 'Found ' + plural(s.tableRows, 'table row', 'table rows') + ' in about ' + plural(s.columns, 'column', 'columns') + (s.textRows ? '; ' + plural(s.textRows, 'other line', 'other lines') + ' (titles, notes) kept in the first column.' : '.') });
    if (s.repeatedHeaders) notes.push({ level: 'info', text: 'A header row repeated on ' + plural(s.repeatedHeaders, 'later page', 'later pages') + ' was kept only once.' });
    notes.push({ level: 'warn', text: 'Table detection is a best effort. Compare the workbook with the PDF before relying on it, especially totals and blank cells.' });
    return {
      name: C.safeBase(st.src.name) + '.xlsx', bytes: res.bytes, mime: XLSX_MIME, notes: notes, preview: previewRows(sheets[0].rows, 14),
      summary: plural(rowsN, 'row', 'rows') + ' in ' + plural(sheets.length, 'sheet', 'sheets') + ' from ' + plural(pages.length, 'page', 'pages') + '.'
    };
  }

  /* ---------- Office file inspection ---------- */
  async function runInspect() {
    progress(0.3, 'Reading the parts of the file'); await tick();
    var res = await window.QOffice.inspect(C, st.src.bytes, { name: st.src.name, now: new Date() });
    progress(0.8, 'Checking the container'); await tick();
    return { inspection: res };
  }

  function sectionHtml(s) {
    var h = '<h4 class="cv-sect">' + esc(s.title) + '</h4>';
    if (s.kind === 'kv') return h + (s.rows.length ? '<dl class="kv">' + s.rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' : '<p class="muted small">' + esc(s.empty || 'Nothing to show.') + '</p>');
    if (s.kind === 'list') return h + '<ul class="cv-list">' + s.rows.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    return h + '<div class="cv-tablewrap"><table class="cv-table"><thead><tr>' + s.head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      s.rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td>' + esc(x) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  async function finishInspection(out) {
    var res = out.inspection, bytes = st.src.bytes, name = st.src.name, rep = U.getReport();
    var hash = await U.sha256(bytes), trailing = null;
    if (res.zip.trailing) trailing = { offset: res.zip.trailing.offset, bytes: res.zip.trailing.bytes, hash: await U.sha256(bytes.slice(res.zip.trailing.offset)) };
    st.inspected = { name: name, size: bytes.length, hash: hash, res: res, trailing: trailing };
    var warns = res.findings.filter(function (f) { return f.level === 'warn'; }).length;
    U.log('inspect', 'Inspected ' + res.kindName.toLowerCase() + ': ' + plural(warns, 'point to check', 'points to check'), [{ role: 'Examined', name: name, size: bytes.length, hash: hash }]);
    var h = '<div class="result ok"><b>Done.</b> ' + esc(res.kindName) + ' with ' + plural(res.parts, 'part', 'parts') + ': ' + plural(warns, 'point to check', 'points to check') + ', ' + plural(res.findings.length - warns, 'note', 'notes') + '.</div>';
    h += '<div class="card"><h3>' + esc(name) + '</h3><dl class="kv"><dt>Type</dt><dd>' + esc(res.kindName) + '</dd><dt>Size</dt><dd>' + U.fmtBytes(bytes.length) + '</dd><dt>SHA-256</dt><dd class="mono">' + esc(hash) + '</dd></dl>' +
      '<p class="muted small">Hash of the file exactly as it was opened, for recording evidence integrity.</p></div>';
    h += '<div class="card"><h3>Findings</h3>';
    if (!res.findings.length) h += '<div class="finding ok"><span class="mark"><b>✓</b></span><span>These checks found nothing to point out.</span></div><p class="muted small">That is not proof the file is genuine or unaltered. These checks only catch the common traces.</p>';
    else res.findings.forEach(function (f) { h += '<div class="finding ' + f.level + '"><span class="mark"><b>' + (f.level === 'warn' ? '!' : 'i') + '</b></span><span>' + esc(f.text) + '</span></div>'; });
    h += '</div>';
    res.sections.forEach(function (s) { h += '<div class="card">' + sectionHtml(s) + '</div>'; });
    h += '<div class="card"><h3>Case report</h3><p class="muted small">One printable page with the hash, findings, everything above, and a log of what was done in this session.</p>' +
      '<div><label class="field"><span>Case reference (optional)</span><input type="text" id="cvCase" maxlength="80" spellcheck="false" value="' + esc(rep.caseRef) + '"></label>' +
      '<label class="field"><span>Examiner (optional)</span><input type="text" id="cvExaminer" maxlength="80" spellcheck="false" value="' + esc(rep.examiner) + '"></label></div>' +
      '<div class="row"><button class="btn accent" id="cvRptGo">' + ic('download') + 'Export case report</button></div></div>';
    $('#cvResult').innerHTML = h;
    $('#cvCase').oninput = function () { rep.caseRef = this.value; };
    $('#cvExaminer').oninput = function () { rep.examiner = this.value; };
    $('#cvRptGo').onclick = exportOfficeReport;
    $('#cvResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function exportOfficeReport() {
    var s = st.inspected; if (!s) return;
    var rep = U.getReport(), btn = $('#cvRptGo');
    btn.disabled = true;
    try {
      var html = window.QReport.buildOffice({
        tool: { name: 'Quanttum PDF', version: '0.3' }, generated: new Date(), caseRef: rep.caseRef.trim(), examiner: rep.examiner.trim(),
        file: { name: s.name, size: s.size, hash: s.hash, kindName: s.res.kindName, trailing: s.trailing }, findings: s.res.findings, sections: s.res.sections, log: U.getLog()
      });
      var base = s.name.replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]+/g, '_'), fname = base + ' - case report.html';
      var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      var a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      U.log('report', 'Case report exported', [{ role: 'Report', name: fname, size: html.length, hash: await U.sha256(new TextEncoder().encode(html)) }]);
      U.toast('Case report downloaded');
    } catch (e) { U.toast('Could not build the report: ' + ((e && e.message) || e), 'bad'); }
    btn.disabled = false;
  }

  /* ================================================================== */
  /* Rendering the view                                                  */
  /* ================================================================== */
  function renderNav() {
    var groups = [['Make a PDF', ['img2pdf', 'txt2pdf', 'doc2pdf', 'xls2pdf']], ['Take a PDF apart', ['pdf2img', 'pdf2txt', 'pdf2doc', 'pdf2xls']], ['Spreadsheets', ['xls2csv', 'csv2xls']], ['Examine a file', ['inspect']]];
    $('#cvNav').innerHTML = groups.map(function (g) {
      return '<div class="cv-group">' + g[0] + '</div>' + g[1].map(function (id) {
        var t = T[id];
        return '<button class="cv-item' + (id === cur ? ' active' : '') + '" data-task="' + id + '">' + ic(t.icon) + '<span><b>' + esc(t.title) + '</b><small>' + esc(t.sub) + '</small></span></button>';
      }).join('');
    }).join('');
    $$('.cv-item', $('#cvNav')).forEach(function (b) { b.onclick = function () { if (!st.busy) renderTask(b.dataset.task); }; });
  }

  function releaseFiles() {
    st.files.forEach(function (f) { if (f.url) URL.revokeObjectURL(f.url); });
    if (st.lastUrl) { URL.revokeObjectURL(st.lastUrl); st.lastUrl = null; }
    st.files = []; st.src = null; st.pages = 0; st.txtName = ''; st.wb = null; st.csv = null;
  }

  function renderTask(id) {
    cur = id; releaseFiles();
    var t = T[id], h = '<div class="cv-head"><h2>' + esc(t.title) + '</h2><p class="muted">' + esc(t.blurb) + '</p></div>';
    if (t.kind === 'text') {
      h += '<div class="card"><h3>Your text</h3><textarea id="cvText" class="cv-text" spellcheck="false" placeholder="Paste or type text here\u2026"></textarea>' +
        '<div class="row"><button class="btn" id="cvOpenTxt">' + ic('open') + 'Open a .txt file</button><span class="muted small" id="cvTxtInfo"></span></div></div>';
    } else {
      var cp = (t.kind === 'pdf') ? U.currentPdf() : null;
      h += '<div class="dropzone" id="cvDrop"><div class="dz-icon">' + ic(KIND[t.kind].icon) + '</div>' +
        '<div><b>Drop ' + KIND[t.kind].noun + ' here</b><br><span class="muted small">or</span></div>' +
        '<div class="row dz-actions"><button class="btn accent" id="cvBrowse">' + ic('open') + (t.multi ? 'Choose images' : 'Choose a file') + '</button>' +
        (cp ? '<button class="btn" id="cvUseOpen" title="Uses the file as it was opened, without unsaved edits">' + ic('page') + 'Use the open document</button>' : '') + '</div></div>';
    }
    h += '<div id="cvFiles"></div>';
    if (t.options) h += '<div class="card cv-opts"><h3>Options</h3>' + t.options() + '</div>';
    h += '<div class="row cv-go"><button class="btn accent big" id="cvGo" disabled>' + ic('convert') + '<span>' + esc(t.action) + '</span></button>' +
      '<div class="cv-progress" id="cvProgress" hidden><div class="track"><div class="bar" id="cvBar"></div></div><span class="muted small" id="cvProgText"></span></div></div>';
    h += '<div id="cvResult"></div><p class="muted small cv-note">' + esc(t.note) + '</p>';
    $('#cvMain').innerHTML = h;
    $('#cvMain').scrollTop = 0;
    renderNav();
    $('#statHint').textContent = 'Conversions run on this computer. Nothing is uploaded.';

    $('#cvGo').onclick = go;
    if (t.kind === 'text') {
      $('#cvText').addEventListener('input', gate);
      $('#cvOpenTxt').onclick = function () { var inp = $('#cvFile'); inp.accept = t.accept; inp.multiple = false; inp.value = ''; inp.onchange = function (e) { loadTextFile(e.target.files[0]); }; inp.click(); };
    } else {
      $('#cvBrowse').onclick = function () { var inp = $('#cvFile'); inp.accept = t.accept; inp.multiple = !!t.multi; inp.value = ''; inp.onchange = function (e) { acceptFiles(e.target.files); }; inp.click(); };
      var dz = $('#cvDrop');
      ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
      dz.addEventListener('drop', function (e) { e.preventDefault(); acceptFiles(e.dataTransfer.files); });
      var uo = $('#cvUseOpen');
      if (uo) uo.onclick = function () { var cp2 = U.currentPdf(); if (cp2) setSource(cp2.name, cp2.bytes.slice()); };
    }
    gate();
  }

  function gate() {
    var go2 = $('#cvGo'); if (!go2) return;
    var t = T[cur], ready = t.kind === 'image' ? st.files.length > 0 : t.kind === 'text' ? val('cvText').trim().length > 0 : !!st.src;
    if (ready && t.kind === 'xlsx') ready = selectedSheets().length > 0;
    go2.disabled = st.busy || !ready;
  }

  async function loadTextFile(f) {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { U.toast('That text file is larger than 5 MB.', 'bad'); return; }
    $('#cvText').value = new TextDecoder('utf-8').decode(new Uint8Array(await f.arrayBuffer())).replace(/^\ufeff/, '');
    st.txtName = f.name; $('#cvTxtInfo').textContent = f.name + ' loaded'; gate();
  }

  function decodeCsv(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), enc: 'UTF-8' };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), enc: 'UTF-8' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''), enc: 'UTF-8' }; }
    catch (e) { return { text: new TextDecoder('windows-1252').decode(bytes), enc: 'Windows-1252' }; }
  }

  async function setSource(name, bytes) {
    var t = T[cur], problem = '', pages = 0, wb = null, csv = null, i;
    if (t.kind === 'pdf') problem = checkPdf(bytes);
    else if (t.kind === 'docx') problem = checkDocx(bytes);
    else if (t.kind === 'office') {
      if (bytes.length > 300 * 1024 * 1024) problem = 'That file is larger than 300 MB, which is too big to inspect in the browser.';
      else if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) problem = 'That is an older Office file (.doc, .xls, .ppt) or a password-protected one. Only .docx, .xlsx and .pptx can be inspected.';
      else if (!window.QOffice.readDirectory(bytes)) problem = 'That is not an Office Open XML file (.docx, .xlsx, .pptx). It is not a zip container.';
    }
    else if (t.kind === 'csv') {
      if (bytes.length > 60 * 1024 * 1024) problem = 'That file is larger than 60 MB, which is too big to convert in the browser.';
      else if (bytes[0] === 0x50 && bytes[1] === 0x4B) problem = 'That looks like an Excel or zip file, not CSV text. Use “Excel to CSV” for workbooks.';
      else if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44) problem = 'That is a PDF, not CSV text. Use “PDF to Excel” for tables in PDFs.';
      else for (i = 0; i < Math.min(bytes.length, 4096); i++) if (bytes[i] === 0 && !(bytes[0] === 0xFF || bytes[0] === 0xFE)) { problem = 'That file does not look like text.'; break; }
    }
    if (problem) { U.toast(problem, 'bad'); return; }
    if (t.kind === 'pdf') {
      try { var pdf = await loadPdf(bytes); pages = pdf.numPages; pdf.destroy(); } catch (e) { U.toast(e.message, 'bad'); return; }
    } else if (t.kind === 'xlsx') {
      try { wb = await Q.readXlsx(bytes); } catch (e) { U.toast(e.message, 'bad'); return; }
    } else if (t.kind === 'csv') {
      csv = decodeCsv(bytes);
      if (!csv.text.trim()) { U.toast('That file is empty.', 'bad'); return; }
      csv.delim = Q.detectDelimiter(csv.text);
      csv.lines = (csv.text.match(/\n/g) || []).length + (csv.text.endsWith('\n') ? 0 : 1);
    }
    st.src = { name: name, bytes: bytes }; st.pages = pages; st.wb = wb; st.csv = csv; st.inspected = null;
    $('#cvResult').innerHTML = '';
    renderFiles(); gate();
  }

  async function acceptFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length || st.busy) return;
    var t = T[cur];
    if (t.kind === 'image') {
      files.forEach(function (f) { st.files.push({ file: f, name: f.name, size: f.size, url: URL.createObjectURL(f) }); });
      $('#cvResult').innerHTML = ''; renderFiles(); gate();
    } else {
      var f = files[0];
      await setSource(f.name, new Uint8Array(await f.arrayBuffer()));
    }
  }

  function sheetCard() {
    var wb = st.wb, h = '<h3 class="cv-sub">Sheets to convert</h3><div class="cv-sheets">';
    wb.sheets.forEach(function (s, i) {
      var vis = s.state === 'visible', dims = s.nRows ? plural(s.nRows, 'row', 'rows') + ' \u00d7 ' + plural(s.nCols, 'column', 'columns') : 'empty';
      h += '<label class="check cv-sheetrow"><input type="checkbox" class="cv-sheet" data-i="' + i + '"' + (vis ? ' checked' : '') + '><span><b>' + esc(s.name) + '</b> <span class="muted small">' + dims + '</span>' +
        (vis ? '' : ' <span class="tag">' + (s.state === 'veryHidden' ? 'very hidden' : 'hidden') + '</span>') + '</span></label>';
    });
    h += '</div>';
    Q.workbookFindings(wb).forEach(function (n) { h += '<div class="finding ' + n.level + '"><span class="mark"><b>' + (n.level === 'warn' ? '!' : 'i') + '</b></span><span>' + esc(n.text) + '</span></div>'; });
    return h;
  }

  function renderFiles() {
    var t = T[cur], box = $('#cvFiles'); if (!box) return;
    if (t.kind === 'image') {
      box.innerHTML = st.files.length ? '<div class="card"><h3>' + plural(st.files.length, 'image', 'images') + ' (in page order)</h3><div class="cv-files">' +
        st.files.map(function (f, i) {
          return '<div class="cv-file"><img src="' + f.url + '" alt=""><div class="cv-fname"><b>' + esc(f.name) + '</b><span class="muted small">' + U.fmtBytes(f.size) + '</span></div>' +
            '<button class="icon-btn" data-up="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ic('up') + '</button>' +
            '<button class="icon-btn" data-down="' + i + '" title="Move down"' + (i === st.files.length - 1 ? ' disabled' : '') + '>' + ic('down') + '</button>' +
            '<button class="icon-btn" data-rm="' + i + '" title="Remove">' + ic('close') + '</button></div>';
        }).join('') + '</div></div>' : '';
      $$('[data-up]', box).forEach(function (b) { b.onclick = function () { var i = +b.dataset.up; st.files.splice(i - 1, 0, st.files.splice(i, 1)[0]); renderFiles(); }; });
      $$('[data-down]', box).forEach(function (b) { b.onclick = function () { var i = +b.dataset.down; st.files.splice(i + 1, 0, st.files.splice(i, 1)[0]); renderFiles(); }; });
      $$('[data-rm]', box).forEach(function (b) { b.onclick = function () { var f = st.files.splice(+b.dataset.rm, 1)[0]; URL.revokeObjectURL(f.url); renderFiles(); gate(); }; });
    } else if (t.kind !== 'text') {
      var extra = '';
      if (st.src && st.wb) extra = sheetCard();
      var meta = st.src ? U.fmtBytes(st.src.bytes.length) + (st.pages ? ' \u00b7 ' + plural(st.pages, 'page', 'pages') : '') +
        (st.wb ? ' \u00b7 ' + plural(st.wb.sheets.length, 'sheet', 'sheets') : '') +
        (st.csv ? ' \u00b7 about ' + plural(st.csv.lines, 'line', 'lines') + ' \u00b7 separator: ' + ({ ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[st.csv.delim]) : '') : '';
      box.innerHTML = st.src ? '<div class="card"><div class="cv-file"><div class="cv-ficon">' + ic(KIND[t.kind].icon) + '</div><div class="cv-fname"><b>' + esc(st.src.name) + '</b>' +
        '<span class="muted small">' + meta + '</span></div>' +
        '<button class="icon-btn" id="cvRmSrc" title="Remove">' + ic('close') + '</button></div>' + extra + '</div>' : '';
      var rm = $('#cvRmSrc'); if (rm) rm.onclick = function () { st.src = null; st.pages = 0; st.wb = null; st.csv = null; renderFiles(); gate(); };
      $$('.cv-sheet', box).forEach(function (b) { b.onchange = gate; });
      var pf = $('#cvPages'); if (pf && st.pages) pf.placeholder = 'all (1-' + st.pages + '), or e.g. 1-3, 5, 8-';
    }
  }

  async function go() {
    if (st.busy) return;
    var t = T[cur];
    st.busy = true; gate(); $('#cvResult').innerHTML = ''; progress(0, 'Starting\u2026');
    try {
      var out = await t.run();
      if (out.inspection) { progress(1, 'Done'); await finishInspection(out); return; }
      progress(1, 'Checking the result'); await tick();
      out.hash = await U.sha256(out.bytes);
      if (st.src) out.source = { name: st.src.name, hash: await U.sha256(st.src.bytes) };
      U.log('convert', t.title + (out.summary ? ': ' + out.summary : ''), (out.source ? [{ role: 'Source', name: out.source.name, size: st.src ? st.src.bytes.length : null, hash: out.source.hash }] : []).concat([{ role: 'Output', name: out.name, size: out.bytes.length, hash: out.hash }]));
      renderResult(out);
    } catch (e) {
      console.warn('[convert] ' + ((e && e.message) || e));
      $('#cvResult').innerHTML = '<div class="result bad"><b>Could not convert.</b> ' + esc((e && e.message) || e) + '</div>';
    } finally { st.busy = false; progress(null); gate(); }
  }

  function renderResult(out) {
    if (st.lastUrl) URL.revokeObjectURL(st.lastUrl);
    st.lastUrl = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
    var isPdf = out.mime === 'application/pdf';
    var h = '<div class="result ok"><b>Done.</b> ' + esc(out.summary) + '</div><div class="card"><h3>' + esc(out.name) + '</h3><dl class="kv">' +
      '<dt>Size</dt><dd>' + U.fmtBytes(out.bytes.length) + '</dd><dt>SHA-256</dt><dd class="mono">' + esc(out.hash) + '</dd>' +
      (out.source ? '<dt>Source</dt><dd>' + esc(out.source.name) + '<br><span class="mono">' + esc(out.source.hash) + '</span></dd>' : '') + '</dl>';
    (out.notes || []).forEach(function (n) { h += '<div class="finding ' + n.level + '"><span class="mark"><b>' + (n.level === 'warn' ? '!' : 'i') + '</b></span><span>' + esc(n.text) + '</span></div>'; });
    if (out.preview) h += '<pre class="cv-preview">' + esc(out.preview) + '</pre>';
    h += '<div class="row cv-actions"><a class="btn accent" id="cvDl" href="' + st.lastUrl + '" download="' + esc(out.name) + '">' + ic('download') + 'Download</a>' +
      (isPdf ? '<button class="btn" id="cvOpenEd">' + ic('open') + 'Open in the editor</button>' : '') + '</div>' +
      '<p class="muted small">The converted file is a new file. It does not carry over the source\u2019s metadata, so its hash differs from the source.</p></div>';
    $('#cvResult').innerHTML = h;
    var oe = $('#cvOpenEd'); if (oe) oe.onclick = function () { U.openInEditor(out.bytes.slice(), out.name); };
    $('#cvResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  window.QConvertUI = {
    show: function () {
      if (!built) { built = true; renderTask(cur); return; }
      if (!st.src && !st.files.length && T[cur].kind === 'pdf') renderTask(cur);
      $('#statHint').textContent = 'Conversions run on this computer. Nothing is uploaded.';
    }
  };
})();
