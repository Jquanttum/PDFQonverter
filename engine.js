/*  Quanttum PDF - engine.js
 *  Pure logic, no DOM. Runs in the browser (window.QEngine) and in Node (for tests).
 *
 *  Coordinate convention used everywhere in the app:
 *    "view space"  = points, origin top-left of the page AS DISPLAYED (after rotation), y grows down.
 *    "pdf space"   = the page's own user space (origin bottom-left of the unrotated page, y grows up).
 *  A page "geometry" g = { x0, y0, W, H, R }:
 *    x0,y0 = lower-left corner of the page box, W,H = UNROTATED width/height, R = total rotation (0/90/180/270).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Geometry                                                            */
  /* ------------------------------------------------------------------ */
  function normRot(r) { return ((Math.round(r / 90) * 90) % 360 + 360) % 360; }

  function viewSize(g) {
    return (g.R % 180 === 0) ? { w: g.W, h: g.H } : { w: g.H, h: g.W };
  }

  function viewToPdf(g, vx, vy) {
    var px, py;
    switch (g.R) {
      case 0:   px = vx;       py = g.H - vy; break;
      case 90:  px = vy;       py = vx;       break;
      case 180: px = g.W - vx; py = vy;       break;
      default:  px = g.W - vy; py = g.H - vx; break; // 270
    }
    return [g.x0 + px, g.y0 + py];
  }

  function pdfToView(g, x, y) {
    var px = x - g.x0, py = y - g.y0;
    switch (g.R) {
      case 0:   return [px, g.H - py];
      case 90:  return [py, px];
      case 180: return [g.W - px, py];
      default:  return [g.H - py, g.W - px]; // 270
    }
  }

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function latin1(bytes, start, end) {
    var s = '', CH = 0x8000;
    for (var i = start; i < end; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CH)));
    }
    return s;
  }

  function hexToRgb(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  function dataUrlToBytes(url) {
    var comma = url.indexOf(',');
    var meta = url.slice(0, comma), data = url.slice(comma + 1);
    var mime = (/data:([^;]+)/.exec(meta) || [])[1] || '';
    var bin = (typeof atob === 'function') ? atob(data) : Buffer.from(data, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { bytes: out, mime: mime };
  }

  /** Replace characters a standard PDF font cannot encode (it only knows WinAnsi/Latin-1 text). */
  function sanitizeText(font, text) {
    var out = '';
    var chars = Array.from(String(text).replace(/\t/g, '    '));
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      try { font.widthOfTextAtSize(ch, 1); out += ch; } catch (e) { out += '?'; }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Forensic: revision scanner                                          */
  /* ------------------------------------------------------------------ */
  /**
   * A PDF that has been edited with "incremental save" keeps every earlier version inside the file:
   * each save appends new objects, a new cross-reference section and a new %%EOF.
   * We only count %%EOF markers that are really preceded by "startxref <offset>", so a stray
   * "%%EOF" inside a binary stream is not mistaken for a revision boundary.
   */
  function scanRevisions(bytes) {
    var n = bytes.length;
    var text = latin1(bytes, 0, n);
    var re = /startxref[\r\n\t ]+(\d+)[\r\n\t ]*%%EOF/g;
    var m, found = [];
    while ((m = re.exec(text)) !== null) {
      var end = m.index + m[0].length;
      // swallow the line ending that normally follows %%EOF
      if (text[end] === '\r') end++;
      if (text[end] === '\n') end++;
      found.push({ end: end, xrefOffset: parseInt(m[1], 10) });
    }
    var head = text.slice(0, 1024);
    var linearized = /\/Linearized\s/.test(head);
    // Linearized ("fast web view") files legitimately contain two EOF markers for ONE revision.
    if (linearized && found.length >= 2) found.shift();

    var revisions = [], prev = 0;
    for (var i = 0; i < found.length; i++) {
      revisions.push({
        index: i + 1,
        end: found[i].end,
        size: found[i].end,
        addedBytes: found[i].end - prev,
        xrefOffset: found[i].xrefOffset
      });
      prev = found[i].end;
    }
    var lastEnd = revisions.length ? revisions[revisions.length - 1].end : 0;
    var tail = text.slice(lastEnd);
    var trailingBytes = tail.replace(/[\r\n\t \0]+/g, '').length ? (n - lastEnd) : 0;
    var vm = /%PDF-(\d\.\d)/.exec(head);
    return {
      fileSize: n,
      version: vm ? vm[1] : null,
      linearized: linearized,
      revisions: revisions,
      trailingBytes: trailingBytes
    };
  }

  function sliceRevision(bytes, rev) {
    return bytes.slice(0, rev.end);
  }

  /* ------------------------------------------------------------------ */
  /* Forensic: PDF date parsing + metadata consistency checks            */
  /* ------------------------------------------------------------------ */
  /** D:YYYYMMDDHHmmSSOHH'mm'  ->  Date (or null) */
  function parsePdfDate(s) {
    if (!s) return null;
    var m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+\-]\d{2}'?\d{0,2}'?)?/.exec(String(s).trim());
    if (!m) return null;
    var y = +m[1], mo = +(m[2] || 1), d = +(m[3] || 1), h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0);
    var t = Date.UTC(y, mo - 1, d, h, mi, se);
    var tz = m[7];
    if (tz && tz !== 'Z') {
      var tm = /([+\-])(\d{2})'?(\d{2})?/.exec(tz);
      if (tm) {
        var off = (+tm[2]) * 60 + (+(tm[3] || 0));
        t -= (tm[1] === '+' ? 1 : -1) * off * 60000;
      }
    }
    return isNaN(t) ? null : new Date(t);
  }

  function parseIsoDate(s) {
    if (!s) return null;
    var d = new Date(String(s).trim());
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * info: {Title, Author, Creator, Producer, CreationDate, ModDate}  (PDF /Info dictionary)
   * xmp:  {createDate, modifyDate, producer, creatorTool}            (parsed XMP, may be empty)
   * Returns [{level:'warn'|'info', text}]
   */
  function analyseMetadata(info, xmp) {
    info = info || {}; xmp = xmp || {};
    var out = [];
    var c = parsePdfDate(info.CreationDate), m = parsePdfDate(info.ModDate);
    if (c && m && m.getTime() < c.getTime()) {
      out.push({ level: 'warn', text: 'The modification date is earlier than the creation date. A document cannot be modified before it exists, so one of the two dates was altered or written by a faulty tool.' });
    }
    var now = Date.now();
    if ((c && c.getTime() > now + 86400000) || (m && m.getTime() > now + 86400000)) {
      out.push({ level: 'warn', text: 'A date in the metadata lies in the future.' });
    }
    var xc = parseIsoDate(xmp.createDate), xm = parseIsoDate(xmp.modifyDate);
    if (c && xc && Math.abs(c.getTime() - xc.getTime()) > 2000) {
      out.push({ level: 'warn', text: 'Creation date differs between the Info dictionary and the XMP packet. Tools normally write both together; a mismatch suggests one was edited separately.' });
    }
    if (m && xm && Math.abs(m.getTime() - xm.getTime()) > 2000) {
      out.push({ level: 'warn', text: 'Modification date differs between the Info dictionary and the XMP packet.' });
    }
    if (info.Producer && xmp.producer && info.Producer.trim() !== xmp.producer.trim()) {
      out.push({ level: 'warn', text: 'Producer differs between Info ("' + info.Producer + '") and XMP ("' + xmp.producer + '").' });
    }
    var hasAny = ['Title', 'Author', 'Creator', 'Producer', 'CreationDate', 'ModDate'].some(function (k) { return info[k]; });
    if (!hasAny && !xmp.createDate && !xmp.producer) {
      out.push({ level: 'info', text: 'No creation metadata is present. It was either stripped or never written.' });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Build the output document                                           */
  /* ------------------------------------------------------------------ */
  function bboxOf(a) {
    if (a.type === 'pen') {
      var xs = [], ys = [];
      for (var i = 0; i < a.pts.length; i += 2) { xs.push(a.pts[i]); ys.push(a.pts[i + 1]); }
      var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
      return { x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 };
    }
    if (a.type === 'text' && !(a.w > 0 && a.h > 0)) {
      // size not recorded: estimate generously so nothing slips out from under a redaction box
      var lines = String(a.text || '').split('\n'), size = a.size || 14, longest = 0;
      lines.forEach(function (l) { longest = Math.max(longest, l.length); });
      return { x: a.x, y: a.y, w: longest * size * 0.62, h: lines.length * size * 1.2 };
    }
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /**
   * opts = {
   *   PDFLib,                       // the pdf-lib module
   *   sources: { id: Uint8Array },  // original file bytes
   *   pages:   [{uid, src, idx, extra, blank, geom:{x0,y0,W,H,rot0,(w,h for blank)}}],
   *   annotations: { uid: [annotation,...] },   // view-space annotations, array order = z-order
   *   images:  { imgId: dataUrl },
   *   rasterize: async (entry, rects) => ({bytes, mime, w, h})   // supplied by the app (needs a canvas)
   *   scrub:   boolean               // true = write no document metadata at all
   * }
   * returns { bytes, rasterized:[uid], droppedUnderRedaction:number }
   */
  async function buildPdf(opts) {
    var PDFLib = opts.PDFLib;
    var PDFDocument = PDFLib.PDFDocument, StandardFonts = PDFLib.StandardFonts,
        rgb = PDFLib.rgb, degrees = PDFLib.degrees, BlendMode = PDFLib.BlendMode,
        LineCapStyle = PDFLib.LineCapStyle;

    var srcDocs = {};
    for (var id in opts.sources) {
      srcDocs[id] = await PDFDocument.load(opts.sources[id], { updateMetadata: false });
    }
    var out = await PDFDocument.create({ updateMetadata: false });

    // ---- document metadata ----
    var firstId = Object.keys(srcDocs)[0];
    if (!opts.scrub && firstId) {
      var sd = srcDocs[firstId];
      try {
        if (sd.getTitle()) out.setTitle(sd.getTitle());
        if (sd.getAuthor()) out.setAuthor(sd.getAuthor());
        if (sd.getSubject()) out.setSubject(sd.getSubject());
        if (sd.getKeywords()) out.setKeywords([sd.getKeywords()]);
        if (sd.getCreator()) out.setCreator(sd.getCreator());
        if (sd.getCreationDate()) out.setCreationDate(sd.getCreationDate());
      } catch (e) { /* unreadable metadata is simply not copied */ }
      out.setProducer('Quanttum PDF');
      out.setModificationDate(new Date());
    }

    var fontCache = {}, imgCache = {};
    async function getFont(family, bold) {
      var key = family + (bold ? '-b' : '');
      if (!fontCache[key]) {
        var name = ({
          Helvetica: bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica,
          Times:     bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman,
          Courier:   bold ? StandardFonts.CourierBold : StandardFonts.Courier
        })[family] || StandardFonts.Helvetica;
        fontCache[key] = await out.embedFont(name);
      }
      return fontCache[key];
    }
    async function getImage(imgId) {
      if (!imgCache[imgId]) {
        var d = dataUrlToBytes(opts.images[imgId]);
        imgCache[imgId] = /jpe?g/i.test(d.mime) ? await out.embedJpg(d.bytes) : await out.embedPng(d.bytes);
      }
      return imgCache[imgId];
    }

    var rasterized = [], dropped = 0;

    for (var pi = 0; pi < opts.pages.length; pi++) {
      var entry = opts.pages[pi];
      var anns = (opts.annotations[entry.uid] || []).slice();
      var rot0 = entry.blank ? 0 : (entry.geom.rot0 || 0);
      var R = normRot(rot0 + (entry.extra || 0));
      var page, g;

      var redactIdx = [];
      anns.forEach(function (a, i) { if (a.type === 'redact') redactIdx.push(i); });

      if (entry.blank) {
        page = out.addPage([entry.geom.W, entry.geom.H]);
        g = { x0: 0, y0: 0, W: entry.geom.W, H: entry.geom.H, R: R };
        if (R) page.setRotation(degrees(R));
        redactIdx = []; // nothing to hide on an empty page
      } else if (redactIdx.length) {
        // TRUE redaction: the page is replaced by a picture with the boxes burned in,
        // so the covered text/vector data no longer exists anywhere in the file.
        var vs = viewSize({ W: entry.geom.W, H: entry.geom.H, R: R });
        var rects = redactIdx.map(function (i) { return { x: anns[i].x, y: anns[i].y, w: anns[i].w, h: anns[i].h }; });
        var ras = await opts.rasterize(entry, rects);
        page = out.addPage([vs.w, vs.h]);
        var img = ras.mime === 'image/png' ? await out.embedPng(ras.bytes) : await out.embedJpg(ras.bytes);
        page.drawImage(img, { x: 0, y: 0, width: vs.w, height: vs.h });
        g = { x0: 0, y0: 0, W: vs.w, H: vs.h, R: 0 };
        rasterized.push(entry.uid);
      } else {
        var copied = await out.copyPages(srcDocs[entry.src], [entry.idx]);
        page = out.addPage(copied[0]);
        g = { x0: entry.geom.x0, y0: entry.geom.y0, W: entry.geom.W, H: entry.geom.H, R: R };
        page.setRotation(degrees(R));
      }

      // ---- annotations ----
      for (var ai = 0; ai < anns.length; ai++) {
        var a = anns[ai];
        if (a.type === 'redact') continue; // already burned in
        if (redactIdx.length) {
          // anything that lies UNDER a redaction box (earlier in z-order) must not survive
          var bb = bboxOf(a), hidden = false;
          for (var k = 0; k < redactIdx.length; k++) {
            if (redactIdx[k] > ai && intersects(bb, anns[redactIdx[k]])) { hidden = true; break; }
          }
          if (hidden) { dropped++; continue; }
        }
        await drawAnnotation(page, g, a);
      }
    }

    async function drawAnnotation(page, g, a) {
      var col = hexToRgb(a.color);
      var color = rgb(col.r, col.g, col.b);
      var p1, p2;
      if (a.type === 'highlight' || a.type === 'whiteout' || a.type === 'rect') {
        p1 = viewToPdf(g, a.x, a.y);
        p2 = viewToPdf(g, a.x + a.w, a.y + a.h);
        var o = { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
        if (a.type === 'highlight') {
          var ho = { x: o.x, y: o.y, width: o.width, height: o.height, color: color, opacity: 0.45 };
          if (BlendMode && BlendMode.Multiply) ho.blendMode = BlendMode.Multiply;
          page.drawRectangle(ho);
        } else if (a.type === 'whiteout') {
          page.drawRectangle({ x: o.x, y: o.y, width: o.width, height: o.height, color: rgb(1, 1, 1) });
        } else {
          page.drawRectangle({ x: o.x, y: o.y, width: o.width, height: o.height, borderColor: color, borderWidth: a.width || 2 });
        }
      } else if (a.type === 'pen') {
        for (var i = 2; i < a.pts.length; i += 2) {
          var s = viewToPdf(g, a.pts[i - 2], a.pts[i - 1]);
          var e = viewToPdf(g, a.pts[i], a.pts[i + 1]);
          page.drawLine({
            start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] },
            thickness: a.width || 2, color: color, lineCap: LineCapStyle ? LineCapStyle.Round : undefined
          });
        }
      } else if (a.type === 'text') {
        var font = await getFont(a.font || 'Helvetica', !!a.bold);
        var size = a.size || 14;
        var lines = String(a.text || '').split('\n');
        for (var li = 0; li < lines.length; li++) {
          var line = sanitizeText(font, lines[li]);
          if (!line) continue;
          var bp = viewToPdf(g, a.x, a.y + size * 0.95 + li * size * 1.2);
          page.drawText(line, { x: bp[0], y: bp[1], size: size, font: font, color: color, rotate: degrees(g.R) });
        }
      } else if (a.type === 'img') {
        var im = await getImage(a.imgId);
        var bl = viewToPdf(g, a.x, a.y + a.h);
        page.drawImage(im, { x: bl[0], y: bl[1], width: a.w, height: a.h, rotate: degrees(g.R) });
      }
    }

    var bytes = await out.save();
    return { bytes: bytes, rasterized: rasterized, droppedUnderRedaction: dropped };
  }

  return {
    normRot: normRot, viewSize: viewSize, viewToPdf: viewToPdf, pdfToView: pdfToView,
    hexToRgb: hexToRgb, sanitizeText: sanitizeText, dataUrlToBytes: dataUrlToBytes,
    scanRevisions: scanRevisions, sliceRevision: sliceRevision,
    parsePdfDate: parsePdfDate, analyseMetadata: analyseMetadata,
    bboxOf: bboxOf, intersects: intersects,
    buildPdf: buildPdf
  };
});
