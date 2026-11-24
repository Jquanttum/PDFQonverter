/* PDF Qonverter - app.js
 * Vanilla JS. Uses pdf.js (render/read) and pdf-lib (write), both vendored in /lib, via engine.js.
 */
(function () {
  'use strict';

  var E = window.QEngine;
  var PDFLib = window.PDFLib;
  var pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  var NS = 'http://www.w3.org/2000/svg';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ================================================================== */
  /* Icons                                                               */
  /* ================================================================== */
  var ICONS = {
    open: 'M2.5 6.5A1.5 1.5 0 0 1 4 5h3l1.5 1.8H16A1.5 1.5 0 0 1 17.5 8.3v6.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z',
    addfile: 'M5 2.5h6l4 4v11H5z M11 2.5v4h4 M10 9.5v5 M7.5 12h5',
    save: 'M4 3.5h9.5l3 3v10H4z M7 3.5v4h5v-4 M7 16.5v-5h6v5',
    cursor: 'M5 3v13l3.2-3.2 2.3 4.7 2-.9-2.3-4.6H15z',
    text: 'M4 5V3.5h12V5 M10 3.5v13 M7.5 16.5h5',
    highlight: 'M12.5 3.5l4 4-7 7h-4v-4z M3.5 17h13',
    pen: 'M3 15.5c3-1 3-5 6-5s2 3 4 3 2-2 4-2',
    rect: 'M4 5.5h12v9H4z',
    eraser: 'M4 12l6.5-6.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L9.5 15H6.8z M8 16.5h8',
    redact: 'M3.5 5h13v4h-13z M3.5 12.5h13 M3.5 16h8',
    image: 'M3.5 4.5h13v11h-13z M3.5 13l4-4 3 3 2.5-2.5 3.5 3.5 M13 7.5h.01',
    sign: 'M3 14.5c1.5-.5 3-6 4.5-6s-1 6 .5 6 2-4 3-4 1 3 2 3 1.5-2 3-2 M3 17.5h14',
    undo: 'M7.5 5L4 8.5 7.5 12 M4 8.5h7a4.5 4.5 0 0 1 0 9H8',
    redo: 'M12.5 5L16 8.5 12.5 12 M16 8.5H9a4.5 4.5 0 0 0 0 9h3',
    zoomin: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M14 14l3.5 3.5 M9 6.5v5 M6.5 9h5',
    zoomout: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M14 14l3.5 3.5 M6.5 9h5',
    fit: 'M3.5 7V3.5H7 M13 3.5h3.5V7 M16.5 13v3.5H13 M7 16.5H3.5V13',
    rotate: 'M15.5 10a5.5 5.5 0 1 1-1.8-4.1 M15.5 3.5V7H12',
    rotatel: 'M4.5 10a5.5 5.5 0 1 0 1.8-4.1 M4.5 3.5V7H8',
    trash: 'M4.5 6h11 M8 6V4h4v2 M6 6l.7 10h6.6L14 6 M8.5 9v4.5 M11.5 9v4.5',
    page: 'M5 2.5h6l4 4v11H5z M11 2.5v4h4',
    shield: 'M10 2.5l6 2v5c0 4-2.7 6.7-6 8-3.3-1.3-6-4-6-8v-5z',
    copy: 'M7 7h8v9H7z M5 13V4h8'
  };
  function ic(n) { return '<span class="ico"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + (ICONS[n] || '') + '"/></svg></span>'; }
  function hydrateIcons(root) {
    $$('i[data-icon]', root).forEach(function (i) {
      i.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="' + (ICONS[i.dataset.icon] || '') + '"/></svg>';
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }

  /* ================================================================== */
  /* Constants                                                           */
  /* ================================================================== */
  var TOOLS = [
    { id: 'select', label: 'Select', key: 'V', icon: 'cursor', hint: 'Click an item to select, move or resize it. Double-click text to edit it.' },
    { id: 'text', label: 'Text', key: 'T', icon: 'text', hint: 'Click on the page and type. Ctrl+Enter or clicking away finishes.' },
    { id: 'highlight', label: 'Highlight', key: 'H', icon: 'highlight', hint: 'Drag over text to highlight it.' },
    { id: 'pen', label: 'Draw', key: 'P', icon: 'pen', hint: 'Draw freehand on the page.' },
    { id: 'rect', label: 'Box', key: 'R', icon: 'rect', hint: 'Drag to draw an outlined box.' },
    { id: 'whiteout', label: 'Cover', key: 'W', icon: 'eraser', hint: 'Covers content with a white box. The content underneath stays in the file. Use Redact to remove it for real.' },
    { id: 'redact', label: 'Redact', key: 'X', icon: 'redact', cls: 'redact-tool', hint: 'Drag a box over anything that must be removed permanently. It is applied when you save.' },
    { id: 'img', label: 'Image', key: 'I', icon: 'image', hint: 'Choose a PNG or JPEG, then click where it should go.' },
    { id: 'sig', label: 'Sign', key: 'S', icon: 'sign', hint: 'Click where your signature should go.' }
  ];
  var FONTS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };
  var PALETTE = ['#111111', '#d13438', '#0f6cbd', '#107c10', '#ffb900', '#ffe600', '#ffffff'];
  var RECTLIKE = ['highlight', 'rect', 'whiteout', 'redact'];
  var TYPE_LABEL = { text: 'Text', highlight: 'Highlight', rect: 'Box', whiteout: 'Cover', redact: 'Redaction', pen: 'Drawing', img: 'Image' };

  /* ================================================================== */
  /* State                                                               */
  /* ================================================================== */
  var S = {
    sources: new Map(), pages: [], ann: {}, images: {},
    uidSeq: 1, srcSeq: 1, idSeq: 1, imgSeq: 1,
    cur: 0, zoom: 1.2, tool: 'select', sel: null, selPage: null,
    style: { width: 2, size: 16, font: 'Helvetica', bold: false,
             colors: { text: '#111111', highlight: '#ffe600', pen: '#d13438', rect: '#d13438' } },
    undo: [], redo: [], dirty: false, primary: null,
    pending: null, sigId: null, draft: null, drag: null, editing: null, editPre: null,
    analysis: null, revDetails: null, lastOutput: null, dragIdx: null, dropIdx: null,
    log: [], report: { caseRef: '', examiner: '' }
  };

  /** Session activity log for the case report. Lives only in this tab. */
  function plural(n, x, y) { return n + ' ' + (n === 1 ? x : y); }
  function logEvent(type, text, files) { S.log.push({ time: new Date(), type: type, text: text, files: files || [] }); }

  function snap() { return JSON.stringify({ pages: S.pages, ann: S.ann }); }
  function endChange(pre) {
    var now = snap();
    if (now === pre) return false;
    S.undo.push(pre); if (S.undo.length > 100) S.undo.shift();
    S.redo = []; S.dirty = true; updateButtons();
    return true;
  }
  function restore(json) {
    var o = JSON.parse(json);
    S.pages = o.pages; S.ann = o.ann; S.sel = null; S.selPage = null; S.dirty = true;
    refreshAll();
  }
  /** Run a mutation as one undoable step. mode: 'full' (pages changed) or 'overlay' (annotations only). */
  function act(fn, mode) {
    var pre = snap(); fn(); endChange(pre);
    if (mode === 'full') refreshAll(); else { renderAllOverlays(); renderEditPane(); }
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snap()); restore(S.undo.pop()); updateButtons(); }
  function redo() { if (!S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); updateButtons(); }

  /* ================================================================== */
  /* Small utilities                                                     */
  /* ================================================================== */
  function toast(msg, kind) {
    var t = document.createElement('div'); t.className = 'toast' + (kind === 'bad' ? ' bad' : ''); t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 3200);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(2) + ' MB';
  }
  async function sha256(bytes) {
    if (!(window.crypto && crypto.subtle)) return 'unavailable (open the app through start.bat so it runs on localhost)';
    var d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(d), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function fmtPdfDate(s) {
    var d = E.parsePdfDate(s); if (!d) return s || '';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }
  function pageByUid(uid) { for (var i = 0; i < S.pages.length; i++) if (S.pages[i].uid === uid) return S.pages[i]; return null; }
  function pageEl(uid) { return $('#pages .page[data-uid="' + uid + '"]'); }
  function annList(uid) { return S.ann[uid] || (S.ann[uid] = []); }
  function selAnn() {
    if (!S.sel) return null;
    var l = S.ann[S.selPage] || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === S.sel) return l[i];
    return null;
  }
  function colorFor(type) { return S.style.colors[type] || '#111111'; }
  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  var mctx = document.createElement('canvas').getContext('2d');
  function measureText(a) {
    mctx.font = (a.bold ? 'bold ' : '') + a.size + 'px ' + (FONTS[a.font] || FONTS.Helvetica);
    var lines = String(a.text || '').split('\n'), w = 0;
    lines.forEach(function (l) { w = Math.max(w, mctx.measureText(l || ' ').width); });
    return { w: Math.max(w, 6), h: lines.length * a.size * 1.2 };
  }

  /* ================================================================== */
  /* Geometry of pages                                                   */
  /* ================================================================== */
  function geomOf(e) {
    if (e.blank) return { x0: 0, y0: 0, W: e.w, H: e.h, rot0: 0 };
    return S.sources.get(e.src).geoms[e.idx];
  }
  function rotOf(e) { return E.normRot(geomOf(e).rot0 + (e.extra || 0)); }
  function viewDims(e) { var g = geomOf(e); return E.viewSize({ W: g.W, H: g.H, R: rotOf(e) }); }

  /* ================================================================== */
  /* Loading documents                                                   */
  /* ================================================================== */
  async function readSource(bytes, name) {
    try {
      await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      var m = String((err && err.message) || err);
      if (/encrypt/i.test(m)) throw new Error('This PDF is password-protected. This version cannot edit encrypted files.');
      throw new Error('This file could not be read as a PDF (' + m + ').');
    }
    var pdf = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/' }).promise;
    var geoms = [];
    for (var i = 1; i <= pdf.numPages; i++) {
      var p = await pdf.getPage(i), v = p.view;
      geoms.push({ x0: v[0], y0: v[1], W: v[2] - v[0], H: v[3] - v[1], rot0: E.normRot(p.rotate) });
    }
    return { id: 's' + (S.srcSeq++), name: name, bytes: bytes, pdf: pdf, numPages: pdf.numPages, geoms: geoms };
  }
  async function bytesFromFile(file) { return new Uint8Array(await file.arrayBuffer()); }

  async function openBytes(bytes, name) {
    var src;
    try { src = await readSource(bytes, name); } catch (err) { toast(err.message, 'bad'); return false; }
    S.sources.forEach(function (s) { try { s.pdf.destroy(); } catch (e) { /* ignore */ } });
    S.sources = new Map([[src.id, src]]);
    S.primary = src.id;
    S.pages = []; S.ann = {}; S.undo = []; S.redo = []; S.sel = null; S.selPage = null;
    for (var i = 0; i < src.numPages; i++) S.pages.push({ uid: S.uidSeq++, src: src.id, idx: i, extra: 0 });
    S.dirty = false; S.cur = 0; S.analysis = null; S.revDetails = null; S.lastOutput = null;
    $('#app').classList.remove('empty');
    $('#docTitle').innerHTML = '<b>' + esc(name) + '</b> · ' + src.numPages + (src.numPages === 1 ? ' page' : ' pages');
    S.titleHtml = $('#docTitle').innerHTML;
    document.title = name + ' - PDF Qonverter';
    updateButtons();
    var vw = $('#viewer'); vw.scrollTop = 0;
    refreshAll();
    fitWidth(true);
    analysePrimary();
    return true;
  }
  async function openFile(file) {
    if (S.dirty && !confirm('You have unsaved changes. Open another file anyway?')) return;
    await openBytes(await bytesFromFile(file), file.name);
  }
  async function addPagesFromFile(file) {
    var src;
    try { src = await readSource(await bytesFromFile(file), file.name); } catch (err) { toast(err.message, 'bad'); return; }
    S.sources.set(src.id, src);
    var at = Math.min(S.cur + 1, S.pages.length);
    act(function () {
      var add = [];
      for (var i = 0; i < src.numPages; i++) add.push({ uid: S.uidSeq++, src: src.id, idx: i, extra: 0 });
      S.pages.splice.apply(S.pages, [at, 0].concat(add));
    }, 'full');
    toast('Added ' + src.numPages + (src.numPages === 1 ? ' page' : ' pages') + ' from ' + file.name);
  }

  /* ================================================================== */
  /* Forensic analysis (Inspect tab)                                     */
  /* ================================================================== */
  function parseXmp(raw) {
    var out = {};
    if (!raw) return out;
    out.raw = raw;
    try {
      var doc = new DOMParser().parseFromString(raw, 'text/xml');
      var pick = function (q) {
        var el = doc.getElementsByTagName(q)[0];
        if (el && el.textContent.trim()) return el.textContent.trim();
        var descs = doc.getElementsByTagName('rdf:Description');
        for (var i = 0; i < descs.length; i++) { var v = descs[i].getAttribute(q); if (v) return v; }
        return null;
      };
      out.createDate = pick('xmp:CreateDate'); out.modifyDate = pick('xmp:ModifyDate');
      out.producer = pick('pdf:Producer'); out.creatorTool = pick('xmp:CreatorTool');
    } catch (e) { /* malformed XMP: nothing to compare */ }
    return out;
  }

  async function infoOf(pdf) {
    var md = null; try { md = await pdf.getMetadata(); } catch (e) { /* none */ }
    var raw = null;
    try { raw = md && md.metadata && md.metadata.getRaw ? md.metadata.getRaw() : null; } catch (e) { /* none */ }
    return { info: (md && md.info) || {}, xmp: parseXmp(raw) };
  }

  async function analysePrimary() {
    var src = S.sources.get(S.primary); if (!src) return;
    var scan = E.scanRevisions(src.bytes);
    var im = await infoOf(src.pdf);
    var findings = E.analyseMetadata(im.info, im.xmp);
    if (scan.revisions.length > 1) {
      findings.unshift({ level: 'warn', text: 'This file contains ' + scan.revisions.length + ' saved revisions. Earlier versions of the document are still stored inside it. This is normal for signed or form-filled files, but it also means changes can be reconstructed. See Revisions below.' });
    }
    if (scan.trailingBytes > 0) {
      findings.push({ level: 'warn', text: scan.trailingBytes + ' bytes of data follow the final %%EOF marker. Viewers ignore that data, which makes the area a place where content can be hidden.' });
    }
    if (!scan.revisions.length) {
      findings.push({ level: 'info', text: 'No standard xref/%%EOF trailer was found, so revisions could not be counted. The file may be damaged, or use an unusual layout.' });
    }
    S.analysis = { name: src.name, size: src.bytes.length, pages: src.numPages, scan: scan, info: im.info, xmp: im.xmp, findings: findings, hash: null };
    S.revDetails = null;
    renderInspector();
    var mine = S.analysis;
    try {
      var sg = await window.QSig.analyse(src.bytes, { helpers: window.QSig.webCryptoHelpers(crypto.subtle), revisions: scan.revisions });
      if (S.analysis === mine) { mine.sigs = sg; renderInspector(); }
    } catch (e) { if (S.analysis === mine) mine.sigs = { signatures: [], findings: [{ level: 'warn', text: 'The signature check failed to run: ' + e.message }] }; }
    S.analysis.hash = await sha256(src.bytes);
    logEvent('open', 'Opened for examination', [{ role: 'Examined', name: src.name, size: src.bytes.length, hash: S.analysis.hash }]);
    renderInspector();
    if (S.analysis && $('.tab[data-tab="inspect"]').classList.contains('active')) loadRevisionDetails();
  }

  async function loadRevisionDetails() {
    var a = S.analysis, src = S.sources.get(S.primary);
    if (!a || !src || S.revDetails || a.scan.revisions.length < 2) return;
    S.revDetails = 'loading'; renderInspector();
    var out = [];
    var list = a.scan.revisions.slice(0, 30);
    for (var i = 0; i < list.length; i++) {
      try {
        var pdf = await pdfjsLib.getDocument({ data: E.sliceRevision(src.bytes, list[i]), cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/' }).promise;
        var im = await infoOf(pdf);
        out.push({ producer: im.info.Producer || '', modDate: im.info.ModDate || '', pages: pdf.numPages });
        pdf.destroy();
      } catch (e) { out.push({ error: true }); }
    }
    S.revDetails = out; renderInspector();
  }

  async function pageLines(pdf, n) {
    var p = await pdf.getPage(n), tc = await p.getTextContent(), rows = new Map();
    tc.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var y = Math.round(it.transform[5] / 2), arr = rows.get(y) || [];
      arr.push({ x: it.transform[4], s: it.str }); rows.set(y, arr);
    });
    return Array.from(rows.entries()).sort(function (a, b) { return b[0] - a[0]; }).map(function (r) {
      return r[1].sort(function (a, b) { return a.x - b.x; }).map(function (o) { return o.s; }).join(' ').replace(/\s+/g, ' ').trim();
    });
  }
  function multisetDiff(a, b) {
    var cnt = {}; b.forEach(function (l) { cnt[l] = (cnt[l] || 0) + 1; });
    var out = [];
    a.forEach(function (l) { if (cnt[l] > 0) cnt[l]--; else out.push(l); });
    return out;
  }
  async function compareRevisions(i) {
    var src = S.sources.get(S.primary), revs = S.analysis.scan.revisions;
    var dlg = $('#diffDlg'), body = $('#diffBody');
    $('#diffTitle').textContent = 'Revision ' + i + ' compared with revision ' + (i - 1);
    body.innerHTML = '<p class="muted"><span class="spinner"></span> Reading both versions…</p>';
    dlg.showModal();
    try {
      var open = function (r) { return pdfjsLib.getDocument({ data: E.sliceRevision(src.bytes, r), cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/' }).promise; };
      var oldDoc = await open(revs[i - 2]), newDoc = await open(revs[i - 1]);
      var html = '', any = false;
      if (oldDoc.numPages !== newDoc.numPages) { html += '<p><b>Page count changed:</b> ' + oldDoc.numPages + ' → ' + newDoc.numPages + '</p>'; any = true; }
      var n = Math.max(oldDoc.numPages, newDoc.numPages);
      for (var p = 1; p <= n; p++) {
        var o = p <= oldDoc.numPages ? await pageLines(oldDoc, p) : [], w = p <= newDoc.numPages ? await pageLines(newDoc, p) : [];
        var rem = multisetDiff(o, w), add = multisetDiff(w, o);
        if (!rem.length && !add.length) continue;
        any = true;
        html += '<div class="diff-page"><h4>Page ' + p + '</h4>' +
          rem.map(function (l) { return '<div class="diff-line del">' + esc(l) + '</div>'; }).join('') +
          add.map(function (l) { return '<div class="diff-line add">' + esc(l) + '</div>'; }).join('') + '</div>';
      }
      if (!any) html += '<p class="muted">No differences in the text. The change may be in images, drawings, form fields or metadata.</p>';
      else html += '<p class="muted small">Red lines were present in the earlier revision and are gone from the later one. Green lines are new. Only text is compared.</p>';
      body.innerHTML = html;
      oldDoc.destroy(); newDoc.destroy();
    } catch (err) {
      body.innerHTML = '<p>Could not compare these revisions: ' + esc(err.message || err) + '</p>';
    }
  }
  async function openRevision(i) {
    if (S.dirty && !confirm('You have unsaved changes. Replace the current document with revision ' + i + '?')) return;
    var src = S.sources.get(S.primary), r = S.analysis.scan.revisions[i - 1];
    var base = S.analysis.name.replace(/\.pdf$/i, '');
    await openBytes(E.sliceRevision(src.bytes, r), base + ' (revision ' + i + ').pdf');
  }

  async function exportReport() {
    var a = S.analysis, src = S.sources.get(S.primary), btn = $('#rptGo');
    if (!a || !src || !a.hash) return;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Building…';
    try {
      var revs = a.scan.revisions, k, waited = 0;
      if (revs.length > 1) {
        if (!S.revDetails) loadRevisionDetails();
        while (!Array.isArray(S.revDetails) && waited < 60000) { await new Promise(function (r) { setTimeout(r, 100); }); waited += 100; }
      }
      var list = [];
      for (k = 0; k < revs.length; k++) {
        var d = revs.length > 1 ? (Array.isArray(S.revDetails) ? S.revDetails[k] : null) : { producer: a.info.Producer || '', modDate: a.info.ModDate || '' };
        list.push({ index: revs[k].index, size: revs[k].size, addedBytes: revs[k].addedBytes, xrefOffset: revs[k].xrefOffset, hash: await sha256(E.sliceRevision(src.bytes, revs[k])),
          producer: d && !d.error ? d.producer : undefined, modDate: d && !d.error ? d.modDate : undefined, error: !!(d && d.error) });
      }
      var trailing = null;
      if (a.scan.trailingBytes > 0 && revs.length) { var off = revs[revs.length - 1].end; trailing = { offset: off, bytes: src.bytes.length - off, hash: await sha256(src.bytes.slice(off)) }; }
      var base = a.name.replace(/\.pdf$/i, '').replace(/[\\\/:*?"<>|]+/g, '_');
      var html = window.QReport.build({
        tool: { name: 'PDF Qonverter', version: '0.4' }, generated: new Date(), caseRef: S.report.caseRef.trim(), examiner: S.report.examiner.trim(), fmtDate: fmtPdfDate,
        evidence: { name: a.name, size: a.size, pages: a.pages, hash: a.hash, version: a.scan.version, linearized: a.scan.linearized, info: a.info, xmp: a.xmp, findings: a.findings, revisions: list, trailing: trailing, signatures: a.sigs && a.sigs.signatures.length ? a.sigs : null },
        log: S.log.slice()
      });
      var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      var link = document.createElement('a'); link.href = url; link.download = base + ' - case report.html'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      logEvent('report', 'Case report exported', [{ role: 'Report', name: base + ' - case report.html', size: html.length, hash: await sha256(new TextEncoder().encode(html)) }]);
      toast('Case report downloaded');
    } catch (err) { console.error(err); toast('Could not build the report: ' + ((err && err.message) || err), 'bad'); }
    renderInspector();
  }

  function renderInspector() {
    var pane = $('#paneInspect'), a = S.analysis;
    if (!a) { pane.innerHTML = '<div class="card"><p class="muted">Open a PDF to inspect its file structure, metadata and hidden revisions.</p></div>'; return; }
    var h = '';
    h += '<div class="card"><h3>File</h3><dl class="kv">' +
      '<dt>Name</dt><dd>' + esc(a.name) + '</dd>' +
      '<dt>Size</dt><dd>' + fmtBytes(a.size) + ' (' + a.size.toLocaleString() + ' bytes)</dd>' +
      '<dt>PDF version</dt><dd>' + esc(a.scan.version || 'unknown') + (a.scan.linearized ? ' · linearized' : '') + '</dd>' +
      '<dt>Pages</dt><dd>' + a.pages + '</dd>' +
      '<dt>SHA-256</dt><dd class="mono">' + (a.hash ? esc(a.hash) : '<span class="spinner"></span>') + '</dd></dl>' +
      (a.hash && /^[0-9a-f]{64}$/.test(a.hash) ? '<div class="row"><button class="btn small-btn" data-copy="' + a.hash + '">' + ic('copy') + 'Copy hash</button></div>' : '') +
      '<p class="muted small">Hash of the file exactly as it was opened, for recording evidence integrity.</p></div>';

    h += '<div class="card"><h3>Findings</h3>';
    if (!a.findings.length) {
      h += '<div class="finding ok"><span class="mark"><b>✓</b></span><span>These checks found no inconsistencies in the metadata or file structure.</span></div>' +
           '<p class="muted small">That is not proof the file is genuine. These checks only catch the common slips.</p>';
    } else {
      a.findings.forEach(function (f) {
        h += '<div class="finding ' + f.level + '"><span class="mark"><b>' + (f.level === 'warn' ? '!' : 'i') + '</b></span><span>' + esc(f.text) + '</span></div>';
      });
    }
    h += '</div>';

    var rows = [['Title', a.info.Title], ['Author', a.info.Author], ['Subject', a.info.Subject], ['Keywords', a.info.Keywords],
      ['Creator', a.info.Creator], ['Producer', a.info.Producer],
      ['Created', a.info.CreationDate ? fmtPdfDate(a.info.CreationDate) : ''], ['Modified', a.info.ModDate ? fmtPdfDate(a.info.ModDate) : '']];
    var xrows = [['Created (XMP)', a.xmp.createDate], ['Modified (XMP)', a.xmp.modifyDate], ['Producer (XMP)', a.xmp.producer], ['Tool (XMP)', a.xmp.creatorTool]];
    var shown = rows.concat(xrows).filter(function (r) { return r[1]; });
    h += '<div class="card"><h3>Metadata</h3>' + (shown.length ?
      '<dl class="kv">' + shown.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' :
      '<p class="muted">This file carries no document metadata.</p>') + '</div>';

    var revs = a.scan.revisions;
    h += '<div class="card"><h3>Revisions (' + revs.length + ')</h3>';
    if (revs.length < 2) {
      h += '<p class="muted">' + (revs.length === 1 ? 'The file was saved once. It holds a single version of the document.' : 'No revision markers found.') + '</p>';
    } else {
      h += '<p class="muted small">Each row is a complete version of the document that is still stored in the file. Viewers only show the last one.</p>' +
        '<table class="rev"><thead><tr><th>#</th><th>Size</th><th>Producer · modified</th><th></th></tr></thead><tbody>';
      revs.forEach(function (r, i) {
        var d = Array.isArray(S.revDetails) ? S.revDetails[i] : null, prev = Array.isArray(S.revDetails) ? S.revDetails[i - 1] : null;
        var det = '<span class="muted">' + (S.revDetails === 'loading' ? '<span class="spinner"></span>' : '…') + '</span>';
        if (d && !d.error) {
          var changed = prev && !prev.error && prev.producer !== d.producer;
          det = '<span class="' + (changed ? 'changed' : '') + '">' + esc(d.producer || 'no producer') + '</span><br><span class="muted">' + esc(d.modDate ? fmtPdfDate(d.modDate) : 'no date') + '</span>';
        } else if (d && d.error) det = '<span class="muted">unreadable</span>';
        h += '<tr><td>' + r.index + '</td><td>' + fmtBytes(r.size) + '<br><span class="muted">+' + fmtBytes(r.addedBytes) + '</span></td><td>' + det + '</td><td><div class="rev-actions">' +
          (i > 0 ? '<button class="btn small-btn" data-cmp="' + r.index + '">Compare</button>' : '') +
          (i < revs.length - 1 ? '<button class="btn small-btn" data-openrev="' + r.index + '">Open</button>' : '') + '</div></td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '</div>';
    if (a.sigs && a.sigs.signatures.length) {
      var sw = a.sigs.findings.filter(function (f) { return f.level === 'warn'; }).length;
      h += '<div class="card" id="sigCard"><h3>Digital signatures (' + a.sigs.signatures.length + ')</h3>' +
        '<p class="muted small">Checks whether the signed bytes are unchanged and whether anything was added after signing. It does not check that the certificate is trusted, so a green result here is not a verdict on who signed.</p>';
      a.sigs.signatures.forEach(function (g) {
        h += '<h4 class="subh">' + esc(g.label) + '</h4><dl class="kv">' + g.rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
      });
      a.sigs.findings.forEach(function (f) {
        h += '<div class="finding ' + f.level + '"><span class="mark"><b>' + (f.level === 'warn' ? '!' : 'i') + '</b></span><span>' + esc(f.text) + '</span></div>';
      });
      h += '</div>';
    }
    h += '<div class="card"><h3>Case report</h3><p class="muted small">One printable page with the hashes, findings, metadata, every revision with its own hash, and a log of what was done in this session. Open it and use Print to make a PDF.</p>' +
      '<div><label class="field"><span>Case reference (optional)</span><input type="text" id="rptCase" value="' + esc(S.report.caseRef) + '" maxlength="80" spellcheck="false"></label>' +
      '<label class="field"><span>Examiner (optional)</span><input type="text" id="rptExaminer" value="' + esc(S.report.examiner) + '" maxlength="80" spellcheck="false"></label></div>' +
      '<div class="row"><button class="btn accent" id="rptGo"' + (a.hash ? '' : ' disabled') + '>' + ic('download') + 'Export case report</button></div></div>';
    if (S.lastOutput) {
      h += '<div class="card"><h3>Last saved file</h3><dl class="kv"><dt>Name</dt><dd>' + esc(S.lastOutput.name) + '</dd><dt>Size</dt><dd>' + fmtBytes(S.lastOutput.bytes.length) + '</dd><dt>SHA-256</dt><dd class="mono">' + esc(S.lastOutput.hash) + '</dd></dl></div>';
    }
    pane.innerHTML = h;
    var rc = $('#rptCase', pane), re = $('#rptExaminer', pane), rg = $('#rptGo', pane);
    if (rc) rc.oninput = function () { S.report.caseRef = rc.value; };
    if (re) re.oninput = function () { S.report.examiner = re.value; };
    if (rg) rg.onclick = exportReport;
    $$('[data-copy]', pane).forEach(function (b) { b.onclick = function () { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(function () { toast('Hash copied'); }); }; });
    $$('[data-cmp]', pane).forEach(function (b) { b.onclick = function () { compareRevisions(+b.dataset.cmp); }; });
    $$('[data-openrev]', pane).forEach(function (b) { b.onclick = function () { openRevision(+b.dataset.openrev); }; });
  }

  /* ================================================================== */
  /* Viewer                                                              */
  /* ================================================================== */
  function refreshAll() {
    var vw = $('#viewer'), top = vw.scrollTop;
    buildViewer(); buildThumbs(); renderEditPane(); updateButtons();
    vw.scrollTop = top;
    updateVisible();
  }
  function buildViewer() {
    var host = $('#pages'); host.innerHTML = '';
    S.pages.forEach(function (e) {
      var d = document.createElement('div'); d.className = 'page'; d.dataset.uid = e.uid;
      var svg = svgEl('svg', { 'class': 'overlay' }); d.appendChild(svg);
      sizePage(d, e);
      attachOverlayEvents(svg, e.uid);
      host.appendChild(d);
      renderOverlay(e.uid);
    });
  }
  function sizePage(d, e) {
    var v = viewDims(e);
    d.style.width = (v.w * S.zoom) + 'px'; d.style.height = (v.h * S.zoom) + 'px';
    d.querySelector('svg.overlay').setAttribute('viewBox', '0 0 ' + v.w + ' ' + v.h);
  }
  function inView(el, root, margin) {
    var r = el.getBoundingClientRect(), v = root.getBoundingClientRect();
    return r.bottom > v.top - margin && r.top < v.bottom + margin;
  }
  function updateVisible() {
    var vw = $('#viewer');
    $$('#pages .page').forEach(function (d) { if (inView(d, vw, 900)) renderPageCanvas(d); else releasePage(d); });
    var th = $('#thumbs');
    $$('#thumbs .thumb').forEach(function (t) { if (inView(t, th, 300)) renderThumb(t); });
    updateCurrentPage();
  }
  function releasePage(d) {
    if (!d._key) return;
    d._key = null;
    if (d._task) { try { d._task.cancel(); } catch (e) { /* ignore */ } d._task = null; }
    var c = d.querySelector('canvas.pdf'); if (c) c.remove();
  }
  async function renderPageCanvas(d) {
    var e = pageByUid(+d.dataset.uid);
    if (!e || e.blank) return;
    var key = S.zoom + '|' + rotOf(e) + '|' + e.idx;
    if (d._key === key) return;
    d._key = key;
    if (d._task) { try { d._task.cancel(); } catch (x) { /* ignore */ } }
    try {
      var page = await S.sources.get(e.src).pdf.getPage(e.idx + 1);
      if (d._key !== key) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var vp = page.getViewport({ scale: S.zoom * dpr, rotation: rotOf(e) });
      var nc = document.createElement('canvas'); nc.className = 'pdf';
      nc.width = Math.floor(vp.width); nc.height = Math.floor(vp.height);
      var task = page.render({ canvasContext: nc.getContext('2d'), viewport: vp });
      d._task = task;
      await task.promise;
      if (d._key !== key) return;
      var old = d.querySelector('canvas.pdf'); if (old) old.remove();
      d.insertBefore(nc, d.firstChild);
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      d._key = null; console.error(err);
    }
  }
  function updateCurrentPage() {
    var vw = $('#viewer'), vr = vw.getBoundingClientRect(), probe = vr.top + vr.height * 0.35, best = S.cur;
    var els = $$('#pages .page');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.top <= probe && r.bottom >= probe) { best = i; break; }
      if (r.top > probe) { best = Math.max(0, i - 1); break; }
      best = i;
    }
    if (best !== S.cur) { S.cur = best; renderEditPane(); }
    $$('#thumbs .thumb').forEach(function (t, i) { t.classList.toggle('current', i === S.cur); });
    var inConvert = $('#app').classList.contains('mode-convert');
    $('#statPage').textContent = (S.pages.length && !inConvert) ? 'Page ' + (S.cur + 1) + ' of ' + S.pages.length : '';
  }
  function goToPage(i) {
    var els = $$('#pages .page'); if (!els[i]) return;
    $('#viewer').scrollTo({ top: els[i].offsetTop - 18, behavior: 'smooth' });
    S.cur = i;
  }
  function setZoom(z, silent) {
    z = Math.max(0.25, Math.min(4, z));
    var vw = $('#viewer'), ratio = vw.scrollHeight ? (vw.scrollTop + vw.clientHeight / 2) / vw.scrollHeight : 0;
    S.zoom = z;
    $('#zoomLabel').textContent = Math.round(z * 100) + '%';
    $$('#pages .page').forEach(function (d) {
      var pe = pageByUid(+d.dataset.uid);
      if (pe) { sizePage(d, pe); d._key = null; }
    });
    renderAllOverlays();
    if (!silent) vw.scrollTop = ratio * vw.scrollHeight - vw.clientHeight / 2;
    updateVisible();
  }
  function fitWidth(silent) {
    if (!S.pages.length) return;
    var maxW = 0; S.pages.forEach(function (e) { maxW = Math.max(maxW, viewDims(e).w); });
    var avail = $('#viewer').clientWidth - 64;
    setZoom(Math.min(2.5, Math.max(0.3, avail / maxW)), silent);
  }

  /* ================================================================== */
  /* Annotation drawing (SVG overlay)                                    */
  /* ================================================================== */
  function renderAllOverlays() { S.pages.forEach(function (e) { renderOverlay(e.uid); }); }

  function annNode(a, draft) {
    var n;
    switch (a.type) {
      case 'highlight':
        n = svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color, 'fill-opacity': 0.45 });
        n.style.mixBlendMode = 'multiply'; break;
      case 'rect':
        n = svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent', stroke: a.color, 'stroke-width': a.width || 2 }); break;
      case 'whiteout':
        n = svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#fff', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 0.75, 'stroke-dasharray': '3 2' }); break;
      case 'redact':
        n = svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#000', 'fill-opacity': 0.9, stroke: '#d13438', 'stroke-width': 1, 'stroke-dasharray': '4 2' }); break;
      case 'pen':
        var pts = []; for (var i = 0; i < a.pts.length; i += 2) pts.push(a.pts[i] + ',' + a.pts[i + 1]);
        n = svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); break;
      case 'text':
        n = svgEl('g', {});
        String(a.text || '').split('\n').forEach(function (line, li) {
          var t = svgEl('text', { x: a.x, y: a.y + a.size * 0.95 + li * a.size * 1.2, fill: a.color, 'font-size': a.size });
          t.style.fontFamily = FONTS[a.font] || FONTS.Helvetica; t.style.fontWeight = a.bold ? 'bold' : 'normal'; t.style.whiteSpace = 'pre';
          t.textContent = line || ' '; n.appendChild(t);
        });
        n.appendChild(svgEl('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent' })); break;
      case 'img':
        n = svgEl('image', { x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' });
        n.setAttribute('href', S.images[a.imgId] || ''); break;
      default: n = svgEl('g', {});
    }
    if (!draft) { n.setAttribute('data-id', a.id); n.classList.add('ann'); }
    return n;
  }
  function renderOverlay(uid) {
    var d = pageEl(uid); if (!d) return;
    var svg = d.querySelector('svg.overlay'); svg.innerHTML = '';
    (S.ann[uid] || []).forEach(function (a) { if (S.editing === a.id) return; svg.appendChild(annNode(a)); });
    if (S.draft && S.draft.uid === uid) svg.appendChild(annNode(S.draft.a, true));
    var a = (S.sel && S.selPage === uid) ? selAnn() : null;
    if (a && S.editing !== a.id) {
      var b = E.bboxOf(a), pad = 2 / S.zoom;
      svg.appendChild(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: 'none', stroke: '#0f6cbd', 'stroke-width': 1.5 / S.zoom, 'stroke-dasharray': (4 / S.zoom) + ' ' + (3 / S.zoom), 'pointer-events': 'none' }));
      if (RECTLIKE.indexOf(a.type) >= 0 || a.type === 'img') {
        var hs = 10 / S.zoom;
        var h = svgEl('rect', { x: b.x + b.w - hs / 2, y: b.y + b.h - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#0f6cbd', 'stroke-width': 1.5 / S.zoom, 'data-handle': 'se' });
        svg.appendChild(h);
      }
    }
  }

  function select(id, uid) {
    var oldPage = S.selPage;
    S.sel = id; S.selPage = id ? uid : null;
    if (oldPage != null) renderOverlay(oldPage);
    if (uid != null) renderOverlay(uid);
    renderEditPane();
  }

  /* ---------- pointer interaction ---------- */
  function ptOf(ev, svg, uid) {
    var r = svg.getBoundingClientRect(), e = pageByUid(uid), v = viewDims(e);
    var x = (ev.clientX - r.left) / S.zoom, y = (ev.clientY - r.top) / S.zoom;
    return { x: Math.max(0, Math.min(v.w, x)), y: Math.max(0, Math.min(v.h, y)) };
  }
  function attachOverlayEvents(svg, uid) {
    svg.addEventListener('pointerdown', function (ev) { onDown(ev, uid, svg); });
    svg.addEventListener('pointermove', function (ev) { onMove(ev, uid, svg); });
    svg.addEventListener('pointerup', function (ev) { onUp(ev, uid, svg); });
    svg.addEventListener('pointercancel', function (ev) { onUp(ev, uid, svg); });
    svg.addEventListener('dblclick', function (ev) {
      if (S.tool !== 'select') return;
      var n = ev.target.closest && ev.target.closest('[data-id]'); if (!n) return;
      var a = annList(uid).filter(function (x) { return x.id === n.dataset.id; })[0];
      if (a && a.type === 'text') startTextEdit(uid, a, snap());
    });
  }
  function onDown(ev, uid, svg) {
    if (ev.button !== 0) return;
    if (S.editing) finishTextEdit();
    var p = ptOf(ev, svg, uid), tool = S.tool;
    S.cur = S.pages.indexOf(pageByUid(uid)); updateCurrentPage();
    if (tool === 'select') {
      var h = ev.target.closest && ev.target.closest('[data-handle]');
      var n = ev.target.closest && ev.target.closest('[data-id]');
      var a = n ? annList(uid).filter(function (x) { return x.id === n.dataset.id; })[0] : null;
      if (h && selAnn()) {
        var sa = selAnn();
        S.drag = { kind: 'resize', uid: uid, id: sa.id, start: p, orig: JSON.parse(JSON.stringify(sa)), pre: snap() };
        svg.setPointerCapture(ev.pointerId);
      } else if (a) {
        select(a.id, uid);
        S.drag = { kind: 'move', uid: uid, id: a.id, start: p, orig: JSON.parse(JSON.stringify(a)), pre: snap() };
        svg.setPointerCapture(ev.pointerId);
      } else select(null);
      return;
    }
    if (RECTLIKE.indexOf(tool) >= 0) {
      S.draft = { uid: uid, ox: p.x, oy: p.y, pre: snap(), a: { id: 'a' + (S.idSeq++), type: tool, x: p.x, y: p.y, w: 0, h: 0, color: tool === 'redact' ? '#000000' : colorFor(tool), width: S.style.width } };
      svg.setPointerCapture(ev.pointerId);
    } else if (tool === 'pen') {
      S.draft = { uid: uid, pre: snap(), a: { id: 'a' + (S.idSeq++), type: 'pen', pts: [p.x, p.y], color: colorFor('pen'), width: S.style.width } };
      svg.setPointerCapture(ev.pointerId);
    } else if (tool === 'text') {
      createText(uid, p);
    } else if (tool === 'img' || tool === 'sig') {
      placePending(uid, p);
    }
  }
  function onMove(ev, uid, svg) {
    if (S.draft && S.draft.uid === uid) {
      var p = ptOf(ev, svg, uid), a = S.draft.a;
      if (a.type === 'pen') {
        var n = a.pts.length, dx = p.x - a.pts[n - 2], dy = p.y - a.pts[n - 1];
        if (dx * dx + dy * dy > 2) a.pts.push(p.x, p.y);
      } else {
        a.x = Math.min(S.draft.ox, p.x); a.y = Math.min(S.draft.oy, p.y);
        a.w = Math.abs(p.x - S.draft.ox); a.h = Math.abs(p.y - S.draft.oy);
      }
      renderOverlay(uid);
    } else if (S.drag && S.drag.uid === uid) {
      var q = ptOf(ev, svg, uid), g = S.drag, cur = selAnn(); if (!cur) return;
      var dx2 = q.x - g.start.x, dy2 = q.y - g.start.y, o = g.orig;
      if (g.kind === 'move') {
        if (cur.type === 'pen') { for (var i = 0; i < o.pts.length; i += 2) { cur.pts[i] = o.pts[i] + dx2; cur.pts[i + 1] = o.pts[i + 1] + dy2; } }
        else { cur.x = o.x + dx2; cur.y = o.y + dy2; }
      } else {
        if (cur.type === 'img') { cur.w = Math.max(12, o.w + dx2); cur.h = cur.w * o.h / o.w; }
        else { cur.w = Math.max(4, o.w + dx2); cur.h = Math.max(4, o.h + dy2); }
      }
      renderOverlay(uid);
    }
  }
  function onUp(ev, uid, svg) {
    try { svg.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ }
    if (S.draft && S.draft.uid === uid) {
      var d = S.draft; S.draft = null;
      var ok = d.a.type === 'pen' ? d.a.pts.length >= 4 : (d.a.w >= 3 && d.a.h >= 3);
      if (ok) {
        annList(uid).push(d.a); endChange(d.pre);
        select(d.a.id, uid);
        if (d.a.type === 'redact') computeHits(uid, d.a);
      } else renderOverlay(uid);
    } else if (S.drag && S.drag.uid === uid) {
      var g = S.drag; S.drag = null; endChange(g.pre);
      var a = selAnn(); if (a && a.type === 'redact') computeHits(uid, a);
      renderEditPane();
    }
  }

  /* ---------- text editing ---------- */
  function createText(uid, p) {
    var pre = snap();
    var a = { id: 'a' + (S.idSeq++), type: 'text', x: p.x, y: p.y, w: 20, h: S.style.size * 1.2, text: '', size: S.style.size, font: S.style.font, bold: S.style.bold, color: colorFor('text') };
    annList(uid).push(a);
    select(a.id, uid);
    S.holdFocus = true; // the click that creates the box would otherwise blur it straight away
    startTextEdit(uid, a, pre);
  }
  function startTextEdit(uid, a, pre) {
    var d = pageEl(uid); if (!d) return;
    S.editing = a.id; S.editPre = pre; renderOverlay(uid);
    var ta = document.createElement('textarea'); ta.className = 'text-edit'; ta.value = a.text; ta.spellcheck = false;
    ta.style.left = (a.x * S.zoom) + 'px'; ta.style.top = (a.y * S.zoom) + 'px';
    ta.style.fontSize = (a.size * S.zoom) + 'px'; ta.style.fontFamily = FONTS[a.font] || FONTS.Helvetica;
    ta.style.fontWeight = a.bold ? 'bold' : 'normal'; ta.style.color = a.color;
    function fit() { var m = measureText({ text: ta.value || ' ', size: a.size, font: a.font, bold: a.bold }); ta.style.width = (m.w * S.zoom + 14) + 'px'; ta.style.height = (m.h * S.zoom + 2) + 'px'; }
    ta.addEventListener('input', function () { a.text = ta.value; fit(); });
    ta.addEventListener('blur', function () { if (S.holdFocus) return; finishTextEdit(); });
    ta.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); ta.blur(); }
    });
    d.appendChild(ta); fit(); ta.focus();
  }
  function finishTextEdit() {
    if (!S.editing) return;
    var id = S.editing, uid = S.selPage, pre = S.editPre;
    S.editing = null; S.editPre = null;
    var ta = $('textarea.text-edit'); if (ta) { var t = ta; t.remove(); }
    var list = annList(uid), a = list.filter(function (x) { return x.id === id; })[0];
    if (a) {
      if (!String(a.text).trim()) { list.splice(list.indexOf(a), 1); S.sel = null; S.selPage = null; }
      else { var m = measureText(a); a.w = m.w; a.h = m.h; }
    }
    endChange(pre);
    if (S.tool === 'text') setTool('select');
    renderOverlay(uid); renderEditPane();
  }

  /* ---------- images and signatures ---------- */
  function placePending(uid, p) {
    var pd = S.pending;
    if (!pd) {
      if (S.tool === 'sig') openSigDialog(); else chooseImage();
      return;
    }
    var v = viewDims(pageByUid(uid)), w = Math.min(pd.w, v.w * 0.9), h = w * pd.h / pd.w;
    var x = Math.max(0, Math.min(v.w - w, p.x - w / 2)), y = Math.max(0, Math.min(v.h - h, p.y - h / 2));
    var a = { id: 'a' + (S.idSeq++), type: 'img', imgId: pd.imgId, x: x, y: y, w: w, h: h };
    var pre = snap(); annList(uid).push(a); endChange(pre);
    if (S.tool === 'img') S.pending = null;
    setTool('select'); select(a.id, uid);
  }
  function chooseImage() { $('#fileImg').value = ''; $('#fileImg').click(); }
  function registerImage(dataUrl, targetW, cb) {
    var im = new Image();
    im.onload = function () {
      var id = 'i' + (S.imgSeq++); S.images[id] = dataUrl;
      var w = Math.min(targetW, im.naturalWidth), h = w * im.naturalHeight / im.naturalWidth;
      cb({ imgId: id, w: targetW > 0 ? targetW : w, h: (targetW > 0 ? targetW : w) * im.naturalHeight / im.naturalWidth, natW: im.naturalWidth, natH: im.naturalHeight, _h: h });
    };
    im.onerror = function () { toast('That image could not be read.', 'bad'); };
    im.src = dataUrl;
  }

  /* ---------- signature pad ---------- */
  var sig = { drawing: false, last: null, ink: '#111111', dirty: false };
  function openSigDialog() { sigClear(); $('#sigDlg').showModal(); }
  function sigClear() { var c = $('#sigPad'); c.getContext('2d').clearRect(0, 0, c.width, c.height); sig.dirty = false; }
  function sigPt(ev) { var c = $('#sigPad'), r = c.getBoundingClientRect(); return { x: (ev.clientX - r.left) * c.width / r.width, y: (ev.clientY - r.top) * c.height / r.height }; }
  function initSigPad() {
    var c = $('#sigPad'), ctx = c.getContext('2d');
    c.addEventListener('pointerdown', function (ev) { sig.drawing = true; sig.last = sigPt(ev); c.setPointerCapture(ev.pointerId); });
    c.addEventListener('pointermove', function (ev) {
      if (!sig.drawing) return;
      var p = sigPt(ev), l = sig.last;
      ctx.strokeStyle = sig.ink; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.quadraticCurveTo(l.x, l.y, (l.x + p.x) / 2, (l.y + p.y) / 2); ctx.stroke();
      sig.last = p; sig.dirty = true;
    });
    var end = function () { sig.drawing = false; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    $$('#sigDlg [data-ink]').forEach(function (b) {
      b.onclick = function () { sig.ink = b.dataset.ink; $$('#sigDlg [data-ink]').forEach(function (x) { x.classList.toggle('on', x === b); }); };
    });
    $('#sigClear').onclick = sigClear;
    $('#sigCancel').onclick = function () { $('#sigDlg').close(); setTool('select'); };
    $('#sigUse').onclick = function () {
      if (!sig.dirty) { toast('Draw your signature first.'); return; }
      var data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, minX = c.width, minY = c.height, maxX = 0, maxY = 0;
      for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      var pad = 8; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(c.width - 1, maxX + pad); maxY = Math.min(c.height - 1, maxY + pad);
      var out = document.createElement('canvas'); out.width = maxX - minX + 1; out.height = maxY - minY + 1;
      out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
      var url = out.toDataURL('image/png');
      try { localStorage.setItem('qpdf.signature', url); } catch (e) { /* storage unavailable: signature lives for this session only */ }
      useSignature(url);
      $('#sigDlg').close();
    };
  }
  function useSignature(url) {
    registerImage(url, 170, function (info) { S.pending = { imgId: info.imgId, w: 170, h: info.h }; S.sigId = info.imgId; setTool('sig'); toast('Click on the page where the signature should go.'); });
  }

  /* ================================================================== */
  /* Redaction helpers                                                   */
  /* ================================================================== */
  async function textUnder(e, rect) {
    var found = [];
    if (e.blank) return found;
    var page = await S.sources.get(e.src).pdf.getPage(e.idx + 1), tc = await page.getTextContent();
    var gg = geomOf(e), g = { x0: gg.x0, y0: gg.y0, W: gg.W, H: gg.H, R: rotOf(e) };
    tc.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var t = it.transform, w = it.width, h = it.height || Math.hypot(t[2], t[3]);
      var la = Math.hypot(t[0], t[1]) || 1, lb = Math.hypot(t[2], t[3]) || 1;
      var ux = t[0] / la, uy = t[1] / la, vx = t[2] / lb, vy = t[3] / lb, x = t[4], y = t[5];
      var cs = [[x, y], [x + ux * w, y + uy * w], [x + vx * h, y + vy * h], [x + ux * w + vx * h, y + uy * w + vy * h]].map(function (c) { return E.pdfToView(g, c[0], c[1]); });
      var x0 = Math.min.apply(null, cs.map(function (c) { return c[0]; })), x1 = Math.max.apply(null, cs.map(function (c) { return c[0]; }));
      var y0 = Math.min.apply(null, cs.map(function (c) { return c[1]; })), y1 = Math.max.apply(null, cs.map(function (c) { return c[1]; }));
      var ix = Math.max(0, Math.min(x1, rect.x + rect.w) - Math.max(x0, rect.x)), iy = Math.max(0, Math.min(y1, rect.y + rect.h) - Math.max(y0, rect.y));
      var area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
      if (ix * iy / area >= 0.5) found.push(it.str);
    });
    return found;
  }
  async function computeHits(uid, a) {
    var e = pageByUid(uid); if (!e) return;
    try { a.hits = (await textUnder(e, a)).length; } catch (err) { a.hits = null; }
    renderEditPane();
  }
  async function rasterize(entry, rects) {
    var page = await S.sources.get(entry.src).pdf.getPage(entry.idx + 1), R = rotOf(entry), scale = 3;
    var vp = page.getViewport({ scale: scale, rotation: R });
    var c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    ctx.fillStyle = '#000';
    rects.forEach(function (r) { ctx.fillRect(Math.floor(r.x * scale), Math.floor(r.y * scale), Math.ceil(r.w * scale) + 1, Math.ceil(r.h * scale) + 1); });
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.92); });
    var bytes = new Uint8Array(await blob.arrayBuffer());
    c.width = c.height = 0;
    var v = viewDims(entry);
    return { bytes: bytes, mime: 'image/jpeg', w: v.w, h: v.h };
  }
  function redactionPlan() {
    var pagesWith = 0, dropped = 0;
    S.pages.forEach(function (e) {
      if (e.blank) return;
      var l = S.ann[e.uid] || [], ri = [];
      l.forEach(function (a, i) { if (a.type === 'redact') ri.push(i); });
      if (!ri.length) return; pagesWith++;
      l.forEach(function (a, i) {
        if (a.type === 'redact') return;
        var bb = E.bboxOf(a);
        for (var k = 0; k < ri.length; k++) if (ri[k] > i && E.intersects(bb, l[ri[k]])) { dropped++; break; }
      });
    });
    return { pages: pagesWith, dropped: dropped };
  }

  /* ================================================================== */
  /* Thumbnails and page operations                                      */
  /* ================================================================== */
  function buildThumbs() {
    var host = $('#thumbs'); host.innerHTML = '';
    S.pages.forEach(function (e, i) {
      var v = viewDims(e), w = 118, h = Math.round(w * v.h / v.w);
      var t = document.createElement('div'); t.className = 'thumb'; t.draggable = true; t.tabIndex = 0; t.dataset.uid = e.uid; t.dataset.i = i;
      var hasRedact = (S.ann[e.uid] || []).some(function (a) { return a.type === 'redact'; });
      t.innerHTML = '<div class="thumb-page" style="width:' + w + 'px;height:' + h + 'px"></div>' + (hasRedact ? '<span class="badge" title="Has redactions"></span>' : '') +
        '<div class="thumb-label">' + (i + 1) + '</div>' +
        '<div class="thumb-actions"><button class="rot" title="Rotate clockwise" aria-label="Rotate page ' + (i + 1) + '">' + ic('rotate') + '</button>' +
        '<button class="del" title="Delete page" aria-label="Delete page ' + (i + 1) + '">' + ic('trash') + '</button></div>';
      t.addEventListener('click', function () { goToPage(i); });
      t.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') goToPage(i); });
      t.querySelector('.rot').addEventListener('click', function (ev) { ev.stopPropagation(); rotatePage(e.uid, 1); });
      t.querySelector('.del').addEventListener('click', function (ev) { ev.stopPropagation(); deletePage(e.uid); });
      t.addEventListener('dragstart', function (ev) { S.dragIdx = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'page'); t.classList.add('dragging'); });
      t.addEventListener('dragover', function (ev) {
        if (S.dragIdx == null) return; ev.preventDefault();
        var r = t.getBoundingClientRect(), after = ev.clientY > r.top + r.height / 2;
        clearDropMarks(); t.classList.add(after ? 'drop-after' : 'drop-before'); S.dropIdx = after ? i + 1 : i;
      });
      t.addEventListener('drop', function (ev) {
        if (S.dragIdx == null) return; ev.preventDefault();
        var from = S.dragIdx, to = S.dropIdx; endDrag();
        if (to == null) return; if (to > from) to--;
        if (to !== from) act(function () { var m = S.pages.splice(from, 1)[0]; S.pages.splice(to, 0, m); }, 'full');
      });
      t.addEventListener('dragend', endDrag);
      host.appendChild(t);
    });
    $$('#thumbs .thumb')[S.cur] && $$('#thumbs .thumb')[S.cur].classList.add('current');
  }
  function clearDropMarks() { $$('#thumbs .thumb').forEach(function (x) { x.classList.remove('drop-before', 'drop-after'); }); }
  function endDrag() { S.dragIdx = null; S.dropIdx = null; clearDropMarks(); $$('#thumbs .thumb').forEach(function (x) { x.classList.remove('dragging'); }); }
  async function renderThumb(t) {
    var e = pageByUid(+t.dataset.uid); if (!e || e.blank || t._done) return;
    t._done = true;
    try {
      var page = await S.sources.get(e.src).pdf.getPage(e.idx + 1), v = viewDims(e), dpr = Math.min(window.devicePixelRatio || 1, 2);
      var vp = page.getViewport({ scale: 118 / v.w * dpr, rotation: rotOf(e) });
      var c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      var host = t.querySelector('.thumb-page'); if (host) host.appendChild(c);
    } catch (err) { t._done = false; }
  }

  function rotatePage(uid, dir) {
    var e = pageByUid(uid); if (!e) return;
    act(function () {
      var v = viewDims(e);
      e.extra = ((e.extra || 0) + dir * 90 + 360) % 360;
      (S.ann[uid] || []).forEach(function (a) {
        var T = dir > 0 ? function (x, y) { return [v.h - y, x]; } : function (x, y) { return [y, v.w - x]; };
        if (a.type === 'pen') { for (var i = 0; i < a.pts.length; i += 2) { var q = T(a.pts[i], a.pts[i + 1]); a.pts[i] = q[0]; a.pts[i + 1] = q[1]; } }
        else if (a.type === 'text' || a.type === 'img') { var c = T(a.x + a.w / 2, a.y + a.h / 2); a.x = c[0] - a.w / 2; a.y = c[1] - a.h / 2; }
        else { var p1 = T(a.x, a.y), p2 = T(a.x + a.w, a.y + a.h); a.x = Math.min(p1[0], p2[0]); a.y = Math.min(p1[1], p2[1]); a.w = Math.abs(p2[0] - p1[0]); a.h = Math.abs(p2[1] - p1[1]); }
      });
    }, 'full');
  }
  function deletePage(uid) {
    if (S.pages.length <= 1) { toast('A document needs at least one page.'); return; }
    act(function () { S.pages = S.pages.filter(function (e) { return e.uid !== uid; }); if (S.selPage === uid) { S.sel = null; S.selPage = null; } }, 'full');
    S.cur = Math.min(S.cur, S.pages.length - 1);
  }
  function insertBlank() {
    var base = S.pages[S.cur]; if (!base) return;
    var v = viewDims(base), at = S.cur + 1;
    act(function () { S.pages.splice(at, 0, { uid: S.uidSeq++, blank: true, w: v.w, h: v.h, extra: 0 }); }, 'full');
    setTimeout(function () { goToPage(at); }, 30);
  }

  /* ================================================================== */
  /* Edit panel                                                          */
  /* ================================================================== */
  function renderEditPane() {
    var pane = $('#paneEdit');
    if (!S.pages.length) { pane.innerHTML = '<div class="card"><p class="muted">Open a PDF to start editing.</p></div>'; return; }
    var a = selAnn(), kind = a ? a.type : S.tool, tool = TOOLS.filter(function (t) { return t.id === S.tool; })[0];
    var hasColor = ['text', 'highlight', 'pen', 'rect'].indexOf(kind) >= 0, hasWidth = ['pen', 'rect'].indexOf(kind) >= 0, hasFont = kind === 'text';
    var h = '<div class="card"><h3>' + esc(a ? TYPE_LABEL[a.type] + ' (selected)' : tool.label) + '</h3>';
    if (a && a.type === 'redact') {
      h += '<p class="muted">' + (a.hits == null ? 'Checking for text under this box…' : a.hits > 0 ?
        'Covers <b>' + a.hits + '</b> piece' + (a.hits === 1 ? '' : 's') + ' of text. It will be removed from the file when you save.' :
        'No selectable text under this box (empty area, or a scanned image). The pixels under it are still blacked out on save.') + '</p>';
    } else if (a) {
      h += '<p class="muted">Drag to move' + (RECTLIKE.indexOf(a.type) >= 0 || a.type === 'img' ? ', use the corner handle to resize' : '') + '. Press Delete to remove it.</p>';
    } else h += '<p class="muted">' + esc(tool.hint) + '</p>';
    if (hasColor) {
      var val = a ? a.color : colorFor(kind);
      h += '<div class="swatches">' + PALETTE.map(function (c) { return '<button class="swatch' + (c.toLowerCase() === String(val).toLowerCase() ? ' on' : '') + '" data-color="' + c + '" style="background:' + c + '" aria-label="Colour ' + c + '"></button>'; }).join('') +
        '<label class="swatch custom" title="Custom colour"><input type="color" id="colorCustom" value="' + val + '"></label></div>';
    }
    if (hasWidth) h += '<label class="field"><span>Line thickness</span><input type="range" id="lineW" min="1" max="12" step="0.5" value="' + (a ? a.width : S.style.width) + '"></label>';
    if (hasFont) {
      var f = a || S.style;
      h += '<label class="field"><span>Font</span><select id="fontFam">' + Object.keys(FONTS).map(function (k) { return '<option' + (f.font === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Size (pt)</span><input type="number" id="fontSize" min="6" max="120" value="' + (a ? a.size : S.style.size) + '"></label>' +
        '<label class="check"><input type="checkbox" id="fontBold"' + (f.bold ? ' checked' : '') + '><span>Bold</span></label>' +
        '<p class="muted small">Standard PDF fonts: Latin characters only.</p>';
    }
    if (S.tool === 'sig' && !a) h += '<div class="row"><button class="btn" id="btnNewSig">Draw a new signature</button></div>';
    if (a) h += '<div class="row"><button class="btn danger" data-act="delann">' + ic('trash') + 'Delete</button></div>';
    h += '</div>';

    h += '<div class="card"><h3>Page ' + (S.cur + 1) + ' of ' + S.pages.length + '</h3><div class="btn-grid">' +
      '<button class="btn" data-act="rotl">' + ic('rotatel') + 'Rotate left</button><button class="btn" data-act="rotr">' + ic('rotate') + 'Rotate right</button>' +
      '<button class="btn" data-act="blank">' + ic('page') + 'Add blank page</button><button class="btn danger" data-act="delpage">' + ic('trash') + 'Delete page</button></div>' +
      '<p class="muted small">Drag thumbnails on the left to reorder pages.</p></div>';
    pane.innerHTML = h;

    $$('.swatch[data-color]', pane).forEach(function (b) { b.onclick = function () { setColor(b.dataset.color); }; });
    var cc = $('#colorCustom', pane); if (cc) cc.onchange = function () { setColor(cc.value); };
    var lw = $('#lineW', pane); if (lw) lw.onchange = function () { setWidth(+lw.value); };
    var ff = $('#fontFam', pane), fs = $('#fontSize', pane), fb = $('#fontBold', pane);
    if (ff) ff.onchange = function () { setTextStyle({ font: ff.value }); };
    if (fs) fs.onchange = function () { setTextStyle({ size: Math.max(6, Math.min(120, +fs.value || 16)) }); };
    if (fb) fb.onchange = function () { setTextStyle({ bold: fb.checked }); };
    var ns = $('#btnNewSig', pane); if (ns) ns.onclick = openSigDialog;
    $$('[data-act]', pane).forEach(function (b) {
      b.onclick = function () {
        var e = S.pages[S.cur], act2 = b.dataset.act;
        if (act2 === 'rotl') rotatePage(e.uid, -1); else if (act2 === 'rotr') rotatePage(e.uid, 1);
        else if (act2 === 'blank') insertBlank(); else if (act2 === 'delpage') deletePage(e.uid); else if (act2 === 'delann') deleteSelected();
      };
    });
  }
  function setColor(c) {
    var a = selAnn(), kind = a ? a.type : S.tool;
    if (S.style.colors[kind] !== undefined || ['text', 'highlight', 'pen', 'rect'].indexOf(kind) >= 0) S.style.colors[kind] = c;
    if (a) act(function () { a.color = c; }, 'overlay'); else renderEditPane();
  }
  function setWidth(w) { var a = selAnn(); S.style.width = w; if (a) act(function () { a.width = w; }, 'overlay'); }
  function setTextStyle(patch) {
    var a = selAnn();
    Object.keys(patch).forEach(function (k) { S.style[k] = patch[k]; });
    if (a && a.type === 'text') act(function () { Object.keys(patch).forEach(function (k) { a[k] = patch[k]; }); var m = measureText(a); a.w = m.w; a.h = m.h; }, 'overlay');
  }
  function deleteSelected() {
    var a = selAnn(); if (!a) return;
    var uid = S.selPage;
    act(function () { var l = S.ann[uid]; l.splice(l.indexOf(a), 1); S.sel = null; S.selPage = null; }, 'overlay');
  }

  /* ================================================================== */
  /* Tools                                                               */
  /* ================================================================== */
  function buildTools() {
    $('#tools').innerHTML = TOOLS.map(function (t) {
      return '<button class="tool ' + (t.cls || '') + '" data-tool="' + t.id + '" title="' + t.label + ' (' + t.key + ')">' + ic(t.icon).replace('class="ico"', 'class="ico" style="width:20px;height:20px"') + '<span>' + t.label + '</span></button>';
    }).join('');
    $$('#tools .tool').forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    setTool('select');
  }
  function setTool(id) {
    if (S.editing) finishTextEdit();
    S.tool = id; document.body.dataset.tool = id;
    $$('#tools .tool').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === id); });
    if (id !== 'select' && S.sel) { var u = S.selPage; S.sel = null; S.selPage = null; renderOverlay(u); }
    var t = TOOLS.filter(function (x) { return x.id === id; })[0];
    $('#statHint').textContent = t.hint;
    if (id === 'img') { S.pending = null; if (S.pages.length) chooseImage(); }
    if (id === 'sig' && S.pages.length) {
      var saved = null; try { saved = localStorage.getItem('qpdf.signature'); } catch (e) { /* no storage */ }
      if (!S.pending || S.pending.imgId !== S.sigId) {
        if (saved) { S.pending = null; registerImage(saved, 170, function (info) { S.pending = { imgId: info.imgId, w: 170, h: info.h }; S.sigId = info.imgId; toast('Click on the page where the signature should go.'); }); }
        else openSigDialog();
      }
    }
    renderEditPane();
  }
  function updateButtons() {
    var has = S.pages.length > 0;
    $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
    $('#btnSave').disabled = !has; $('#btnAdd').disabled = !has;
  }

  /* ================================================================== */
  /* Saving                                                              */
  /* ================================================================== */
  /* ---------- Edit / Convert mode ---------- */
  function setMode(mode) {
    var conv = mode === 'convert';
    if (S.editing) finishTextEdit();
    $('#app').classList.toggle('mode-convert', conv);
    $('#convertView').hidden = !conv;
    $$('.seg-btn').forEach(function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var dt = $('#docTitle');
    if (conv) {
      dt.textContent = 'Convert files';
      $('#statPage').innerHTML = '&nbsp;';
      if (window.QConvertUI) window.QConvertUI.show();
    } else {
      if (S.titleHtml && S.pages.length) dt.innerHTML = S.titleHtml; else dt.textContent = 'No document open';
      var t = TOOLS.filter(function (x) { return x.id === S.tool; })[0];
      $('#statHint').textContent = t ? t.hint : '';
      updateCurrentPage();
    }
  }
  async function openInEditor(bytes, name) {
    if (S.dirty && !confirm('You have unsaved changes in the editor. Replace the open document?')) return false;
    setMode('edit');
    return openBytes(bytes, name);
  }
  function currentPdf() {
    var src = S.primary && S.sources.get(S.primary);
    return src ? { name: src.name, bytes: src.bytes } : null;
  }

  function openSaveDialog() {
    if (!S.pages.length) return;
    var base = (S.analysis ? S.analysis.name : 'document.pdf').replace(/\.pdf$/i, '').replace(/ \(edited\)$/, '');
    $('#saveName').value = base + ' (edited).pdf';
    var plan = redactionPlan(), annCount = 0;
    Object.keys(S.ann).forEach(function (u) { if (pageByUid(+u)) annCount += S.ann[u].length; });
    var h = '<p>' + S.pages.length + (S.pages.length === 1 ? ' page' : ' pages') + ', ' + annCount + (annCount === 1 ? ' mark-up' : ' mark-ups') + '. Marks are written into the pages.</p>';
    if (plan.pages) {
      h += '<p><b>' + plan.pages + (plan.pages === 1 ? ' page contains' : ' pages contain') + ' redactions.</b> ' + (plan.pages === 1 ? 'It' : 'They') + ' will be converted to pictures with the black boxes burned in, so the covered text no longer exists in the file. Text on ' + (plan.pages === 1 ? 'that page' : 'those pages') + ' will no longer be selectable or searchable.</p>';
      if (plan.dropped) h += '<p>' + plan.dropped + ' mark-up' + (plan.dropped === 1 ? ' lies' : 's lie') + ' underneath a redaction box and will be removed with it.</p>';
    }
    h += '<p class="muted">The saved file is rebuilt from scratch as one clean revision. Earlier revisions and XMP data are not carried over.</p>';
    $('#saveSummary').innerHTML = h;
    $('#saveResult').hidden = true; $('#saveAgain').hidden = true;
    $('#saveGo').disabled = false; $('#saveGo').textContent = 'Save';
    $('#saveDlg').showModal();
    $('#saveName').select();
  }
  function download(out) {
    var url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = out.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  async function doSave() {
    var name = $('#saveName').value.trim() || 'document.pdf'; if (!/\.pdf$/i.test(name)) name += '.pdf';
    var go = $('#saveGo'), result = $('#saveResult');
    go.disabled = true; go.innerHTML = '<span class="spinner"></span> Working…';
    result.hidden = true;
    try {
      // text that will be redacted, remembered so the saved file can be checked against it
      var captured = {};
      for (var i = 0; i < S.pages.length; i++) {
        var e = S.pages[i], list = S.ann[e.uid] || [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].type === 'redact' && !e.blank) { var got = await textUnder(e, list[j]); (captured[e.uid] = captured[e.uid] || []).push.apply(captured[e.uid], got); }
        }
      }
      var used = {}; S.pages.forEach(function (p) { if (!p.blank) used[p.src] = true; });
      var sources = {}; S.sources.forEach(function (s, id) { if (used[id]) sources[id] = s.bytes; });
      var entries = S.pages.map(function (p) { var o = JSON.parse(JSON.stringify(p)); o.geom = geomOf(p); return o; });
      var res = await E.buildPdf({ PDFLib: PDFLib, sources: sources, pages: entries, annotations: S.ann, images: S.images, rasterize: rasterize, scrub: $('#optScrub').checked });

      // verification: the saved file's own text layer must not contain what was redacted
      var leaks = [], checked = 0, rasterised = 0;
      if (res.rasterized.length) {
        var outPdf = await pdfjsLib.getDocument({ data: res.bytes.slice(), cMapUrl: 'lib/cmaps/', cMapPacked: true, standardFontDataUrl: 'lib/standard_fonts/' }).promise;
        for (var k = 0; k < S.pages.length; k++) {
          var uid = S.pages[k].uid; if (res.rasterized.indexOf(uid) < 0) continue;
          rasterised++;
          var tc = await (await outPdf.getPage(k + 1)).getTextContent();
          var hay = tc.items.map(function (it) { return it.str; }).join(' ').toLowerCase();
          (captured[uid] || []).forEach(function (s) { var t = s.trim().toLowerCase(); if (t.length < 3) return; checked++; if (hay.indexOf(t) >= 0) leaks.push(s); });
        }
        outPdf.destroy();
      }
      var raw = ''; if (res.rasterized.length) { var CH = 0x8000, rb = res.bytes; for (var q = 0; q < rb.length; q += CH) raw += String.fromCharCode.apply(null, rb.subarray(q, Math.min(rb.length, q + CH))); }
      Object.keys(captured).forEach(function (u) { captured[u].forEach(function (s) { var t = s.trim(); if (t.length >= 4 && raw.indexOf(t) >= 0 && leaks.indexOf(s) < 0) leaks.push(s); }); });

      var out = { name: name, bytes: res.bytes, hash: await sha256(res.bytes) };
      var rv = E.scanRevisions(res.bytes);
      var html = '<b>' + esc(name) + '</b> · ' + fmtBytes(res.bytes.length) + '<br><span class="mono">SHA-256 ' + esc(out.hash) + '</span><br>Revisions in saved file: ' + rv.revisions.length;
      if (leaks.length) {
        result.className = 'result bad';
        result.innerHTML = '<b>Not saved.</b> ' + leaks.length + ' redacted text item(s) were still found in the output. Nothing was downloaded. Please report this.<br>' + html;
      } else {
        S.lastOutput = out; S.dirty = false;
        logEvent('save', 'Saved as a new PDF' + (rasterised ? '; ' + plural(rasterised, 'page', 'pages') + ' redacted and re-checked (' + checked + ' redacted text item' + (checked === 1 ? '' : 's') + ' searched for in the output, none found)' : ''),
          [{ role: 'Source', name: S.analysis ? S.analysis.name : '', size: S.analysis ? S.analysis.size : null, hash: S.analysis ? S.analysis.hash : null }, { role: 'Output', name: out.name, size: out.bytes.length, hash: out.hash }]);
        download(out);
        result.className = 'result ok';
        result.innerHTML = '<b>Saved.</b> ' + html + (rasterised ? '<br>Redaction check passed: ' + checked + ' redacted text item' + (checked === 1 ? '' : 's') + ' looked for in the saved file, none found.' : '');
        $('#saveAgain').hidden = false; $('#saveAgain').onclick = function () { download(out); };
        renderInspector();
      }
      result.hidden = false;
    } catch (err) {
      console.error(err);
      result.className = 'result bad'; result.innerHTML = 'Saving failed: ' + esc((err && err.message) || err); result.hidden = false;
    }
    go.disabled = false; go.textContent = 'Save again';
  }

  /* ================================================================== */
  /* Wiring                                                              */
  /* ================================================================== */
  function init() {
    hydrateIcons(document);
    buildTools();
    initSigPad();
    renderEditPane(); renderInspector(); updateButtons();

    $('#btnOpen').onclick = $('#btnOpen2').onclick = function () { $('#fileOpen').value = ''; $('#fileOpen').click(); };
    $('#btnAdd').onclick = function () { $('#fileAdd').value = ''; $('#fileAdd').click(); };
    $('#btnSave').onclick = openSaveDialog;
    $('#fileOpen').onchange = function (e) { var f = e.target.files[0]; if (f) openFile(f); };
    $('#fileAdd').onchange = function (e) { var f = e.target.files[0]; if (f) addPagesFromFile(f); };
    $('#fileImg').onchange = function (e) {
      var f = e.target.files[0]; if (!f) { setTool('select'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        var im = new Image();
        im.onload = function () {
          var id = 'i' + (S.imgSeq++); S.images[id] = rd.result;
          var w = Math.min(240, im.naturalWidth);
          S.pending = { imgId: id, w: w, h: w * im.naturalHeight / im.naturalWidth };
          toast('Click on the page where the image should go.');
        };
        im.onerror = function () { toast('That image could not be read.', 'bad'); };
        im.src = rd.result;
      };
      rd.readAsDataURL(f);
    };
    $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
    $('#btnZoomIn').onclick = function () { setZoom(S.zoom * 1.15); };
    $('#btnZoomOut').onclick = function () { setZoom(S.zoom / 1.15); };
    $('#btnFit').onclick = function () { fitWidth(); };
    $('#saveGo').onclick = doSave;
    $('#saveClose').onclick = function () { $('#saveDlg').close(); };
    $('#diffClose').onclick = function () { $('#diffDlg').close(); };
    $$('.seg-btn').forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });

    $$('.tab').forEach(function (t) {
      t.onclick = function () {
        $$('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
        $$('.tabpane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane' + t.dataset.tab.charAt(0).toUpperCase() + t.dataset.tab.slice(1)); });
        if (t.dataset.tab === 'inspect') { renderInspector(); loadRevisionDetails(); }
      };
    });

    var vw = $('#viewer'), ticking = false;
    vw.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; updateVisible(); }); } });
    $('#thumbs').addEventListener('scroll', function () { updateVisible(); });
    window.addEventListener('resize', updateVisible);
    vw.addEventListener('wheel', function (ev) { if (ev.ctrlKey) { ev.preventDefault(); setZoom(S.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });

    window.addEventListener('dragover', function (ev) { ev.preventDefault(); if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') >= 0) document.body.classList.add('dragover'); });
    window.addEventListener('dragleave', function (ev) { if (!ev.relatedTarget) document.body.classList.remove('dragover'); });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault(); document.body.classList.remove('dragover');
      if ($('#app').classList.contains('mode-convert')) return;
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!f) return;
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) openFile(f); else toast('That is not a PDF file.', 'bad');
    });

    window.addEventListener('keydown', function (ev) {
      if (document.querySelector('dialog[open]') || $('#app').classList.contains('mode-convert')) return;
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
      if (mod && k === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (mod && k === 'y') { ev.preventDefault(); redo(); }
      else if (mod && k === 's') { ev.preventDefault(); openSaveDialog(); }
      else if (mod && k === 'o') { ev.preventDefault(); $('#btnOpen').click(); }
      else if (!mod && (k === 'delete' || k === 'backspace')) { if (S.sel) { ev.preventDefault(); deleteSelected(); } }
      else if (k === 'escape') { if (S.sel) select(null); setTool('select'); }
      else if (!mod && !ev.altKey && S.pages.length) {
        var t = TOOLS.filter(function (x) { return x.key.toLowerCase() === k; })[0];
        if (t) setTool(t.id); else if (k === '+' || k === '=') setZoom(S.zoom * 1.15); else if (k === '-') setZoom(S.zoom / 1.15);
      }
    });
    window.addEventListener('pointerup', function () {
      if (!S.holdFocus) return;
      S.holdFocus = false;
      var ta = $('textarea.text-edit'); if (ta && S.editing) ta.focus();
    }, true);
    window.addEventListener('beforeunload', function (ev) { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });

    window.QPDF = {
      state: S, openBytes: openBytes, setMode: setMode,
      ui: { log: logEvent, getLog: function () { return S.log.slice(); }, getReport: function () { return S.report; }, toast: toast, ic: ic, esc: esc, fmtBytes: fmtBytes, sha256: sha256, ICONS: ICONS, openInEditor: openInEditor, currentPdf: currentPdf }
    };
  }
  init();
})();
