/*  Quanttum PDF - converter.js
 *  Pure logic for the Convert view. No DOM. Runs in the browser (window.QConvert) and in Node (tests).
 *
 *  Covers: zip read/write, .docx read/write, text/image/Word -> PDF layout, PDF text -> lines/paragraphs/text,
 *  JPEG metadata inspection and lossless stripping, image sniffing, page-range parsing.
 *
 *  Coordinates for text items passed to layoutLines are "view space": origin top-left, y grows DOWN,
 *  (x, y) is the baseline start of the string, w its width, h its font height. All in points.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QConvert = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8');

  var PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
  var INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/g;

  /* ------------------------------------------------------------------ */
  /* Byte helpers                                                        */
  /* ------------------------------------------------------------------ */
  function concat(chunks) {
    var n = 0, o = 0, i;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var out = new Uint8Array(n);
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }
  function u16(b, o) { return (b[o] | (b[o + 1] << 8)) >>> 0; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function ascii(b, o, n) { var s = ''; for (var i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }

  /* ------------------------------------------------------------------ */
  /* ZIP (store-only writer, inflating reader)                           */
  /* ------------------------------------------------------------------ */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** files: [{name, data:Uint8Array}] -> Uint8Array (a valid .zip, entries stored without compression) */
  function zipStore(files, when) {
    var d = when || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var chunks = [], central = [], offset = 0, cdSize = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true); dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      lh.set(name, 30);
      chunks.push(lh, data);
      var ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch); cdSize += ch.length;
      offset += lh.length + data.length;
    });
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return concat(chunks.concat(central, [end]));
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unpack compressed files. Use a current Chrome, Edge or Firefox.');
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Reads the central directory. Returns { names, has(name), get(name) -> Promise<Uint8Array> }. */
  function zipRead(bytes) {
    var n = bytes.length, i = n - 22, min = Math.max(0, n - 65557);
    while (i >= min && u32(bytes, i) !== 0x06054b50) i--;
    if (i < min) throw new Error('Not a zip container');
    var count = u16(bytes, i + 10), p = u32(bytes, i + 16), entries = {}, names = [];
    for (var k = 0; k < count; k++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('Damaged zip directory');
      var nl = u16(bytes, p + 28), el = u16(bytes, p + 30), cl = u16(bytes, p + 32);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
      entries[name] = { flags: u16(bytes, p + 8), method: u16(bytes, p + 10), csize: u32(bytes, p + 20), usize: u32(bytes, p + 24), lo: u32(bytes, p + 42) };
      names.push(name);
      p += 46 + nl + el + cl;
    }
    return {
      names: names,
      has: function (name) { return Object.prototype.hasOwnProperty.call(entries, name); },
      get: async function (name) {
        var e = entries[name];
        if (!e) throw new Error('Missing ' + name);
        if (e.flags & 1) throw new Error('This file is encrypted.');
        if (e.usize > 200 * 1024 * 1024) throw new Error('A part of this file is unreasonably large.');
        if (u32(bytes, e.lo) !== 0x04034b50) throw new Error('Damaged zip entry');
        var start = e.lo + 30 + u16(bytes, e.lo + 26) + u16(bytes, e.lo + 28);
        var raw = bytes.subarray(start, start + e.csize);
        if (e.method === 0) return raw.slice();
        if (e.method === 8) return inflateRaw(raw);
        throw new Error('Unsupported compression method ' + e.method);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* XML helpers                                                         */
  /* ------------------------------------------------------------------ */
  function xmlDecode(s) {
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var cp = (e.charAt(1) === 'x' || e.charAt(1) === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch (x) { return ''; }
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
  }
  function xmlEscape(s) {
    return String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------------ */
  /* DOCX reading                                                        */
  /* ------------------------------------------------------------------ */
  function parseParagraph(px) {
    var style = (/<w:pStyle\s+w:val="([^"]*)"/.exec(px) || [])[1] || '';
    var kind = 'p', m;
    if (/^title$/i.test(style)) kind = 'title';
    else if ((m = /^heading\s*(\d)$/i.exec(style))) kind = 'h' + Math.min(3, Math.max(1, +m[1]));
    var list = /<w:numPr>/.test(px) || /^list/i.test(style);
    var align = (/<w:jc\s+w:val="(center|right|end)"/.exec(px) || [])[1];
    if (align === 'end') align = 'right';

    var text = '', t;
    var re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>|<w:noBreakHyphen\/>/g;
    while ((t = re.exec(px))) {
      if (t[1] !== undefined) text += xmlDecode(t[1]);
      else if (t[0] === '<w:tab/>') text += '\t';
      else if (t[0] === '<w:noBreakHyphen/>') text += '-';
      else if (/^<w:br/.test(t[0]) && /w:type="page"/.test(t[0])) text += '\f';
      else text += '\n';
    }

    var runs = px.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g) || [], withText = 0, boldRuns = 0;
    runs.forEach(function (r) {
      if (/<w:t[\s>]/.test(r)) {
        withText++;
        if (/<w:b\s*\/>|<w:b\s+w:val="(?:1|true|on)"\s*\/>/.test(r)) boldRuns++;
      }
    });
    return {
      type: 'p', text: text, kind: kind, list: list, align: align || 'left',
      bold: withText > 0 && boldRuns === withText,
      pageBreakBefore: /<w:pageBreakBefore\s*\/>/.test(px)
    };
  }

  /** document.xml text -> { blocks, stats } */
  function parseDocxXml(xml) {
    var blocks = [], stack = [];
    var re = /<w:tbl(?:\s[^>]*)?>|<\/w:tbl>|<w:tr(?:\s[^>]*)?>|<\/w:tr>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, t;
    var paragraphs = 0, tables = 0;
    while ((t = re.exec(xml))) {
      var s = t[0], top = stack[stack.length - 1];
      if (/^<w:tbl[\s>]/.test(s)) { stack.push({ rows: [], row: null, cell: null }); tables++; }
      else if (s === '</w:tbl>') {
        var done = stack.pop(), parent = stack[stack.length - 1];
        if (parent) {
          if (parent.cell) parent.cell.push(done.rows.map(function (r) { return r.join(' | '); }).join(' / '));
        } else blocks.push({ type: 'table', rows: done.rows });
      }
      else if (/^<w:tr[\s>]/.test(s)) { if (top) top.row = []; }
      else if (s === '</w:tr>') { if (top && top.row) { top.rows.push(top.row); top.row = null; } }
      else if (/^<w:tc[\s>]/.test(s)) { if (top) top.cell = []; }
      else if (s === '</w:tc>') { if (top && top.row && top.cell) { top.row.push(top.cell.join('\n')); top.cell = null; } }
      else {
        paragraphs++;
        var p = /\/>$/.test(s) ? { type: 'p', text: '', kind: 'p', list: false, align: 'left', bold: false, pageBreakBefore: false } : parseParagraph(s);
        if (top) { if (top.cell) top.cell.push(p.text.replace(/\f/g, '')); }
        else blocks.push(p);
      }
    }
    while (blocks.length && blocks[blocks.length - 1].type === 'p' && !blocks[blocks.length - 1].text.trim()) blocks.pop();
    var pictures = (xml.match(/<w:drawing[\s>]|<w:pict[\s>]/g) || []).length;
    return { blocks: blocks, stats: { paragraphs: paragraphs, tables: tables, pictures: pictures } };
  }

  async function readDocx(bytes) {
    var zip;
    try { zip = zipRead(bytes); } catch (e) {
      throw new Error('This is not a .docx file. Older .doc files must be re-saved as .docx in Word first.');
    }
    if (!zip.has('word/document.xml')) throw new Error('This zip file is not a Word document (word/document.xml is missing).');
    var xml = dec.decode(await zip.get('word/document.xml'));
    var r = parseDocxXml(xml);
    r.stats.hasHeaderFooter = zip.names.some(function (n) { return /^word\/(header|footer)\d*\.xml$/.test(n); });
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* DOCX writing                                                        */
  /* ------------------------------------------------------------------ */
  function docxRuns(text) {
    var out = '', parts = String(text).split('\n');
    parts.forEach(function (line, li) {
      if (li > 0) out += '<w:r><w:br/></w:r>';
      line.split('\t').forEach(function (seg, si) {
        if (si > 0) out += '<w:r><w:tab/></w:r>';
        if (seg) out += '<w:r><w:t xml:space="preserve">' + xmlEscape(seg) + '</w:t></w:r>';
      });
    });
    return out;
  }

  /** paras: [{text, kind:'p'|'h1'|'h2'|'h3', pageBreakBefore?}]  opts: {pageW, pageH} in points */
  function buildDocx(paras, o) {
    o = o || {};
    var pw = Math.round((o.pageW || PAGE.a4[0]) * 20), ph = Math.round((o.pageH || PAGE.a4[1]) * 20);
    var body = '';
    paras.forEach(function (p) {
      var style = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3' }[p.kind];
      var ppr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (p.pageBreakBefore ? '<w:pageBreakBefore/>' : '');
      body += '<w:p>' + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + docxRuns(p.text) + '</w:p>';
    });
    if (!paras.length) body = '<w:p/>';
    var NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var document = head + '<w:document ' + NS + '><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="' + pw + '" w:h="' + ph + '"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
    function hs(id, name, size, lvl) {
      return '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="' + lvl + '"/></w:pPr><w:rPr><w:b/><w:sz w:val="' + size + '"/></w:rPr></w:style>';
    }
    var styles = head + '<w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      hs('Heading1', 'heading 1', 36, 0) + hs('Heading2', 'heading 2', 30, 1) + hs('Heading3', 'heading 3', 26, 2) + '</w:styles>';
    var types = head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
    var RELNS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
    var rels = head + '<Relationships ' + RELNS + '><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    var docRels = head + '<Relationships ' + RELNS + '><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(types) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'word/document.xml', data: enc.encode(document) },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) },
      { name: 'word/styles.xml', data: enc.encode(styles) }
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* PDF text -> lines -> paragraphs -> text                             */
  /* ------------------------------------------------------------------ */
  function layoutLines(items) {
    var its = (items || []).filter(function (it) {
      return it && typeof it.str === 'string' && it.str.trim().length && isFinite(it.x) && isFinite(it.y);
    });
    its.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    var groups = [], cur = null;
    its.forEach(function (it) {
      var h = it.h > 0 ? it.h : 10;
      if (cur && Math.abs(it.y - cur.y) <= 0.4 * Math.max(h, cur.size)) { cur.items.push(it); cur.size = Math.max(cur.size, h); }
      else { cur = { y: it.y, size: h, items: [it] }; groups.push(cur); }
    });
    return groups.map(function (g) {
      g.items.sort(function (a, b) { return a.x - b.x; });
      var text = '', prev = null;
      g.items.forEach(function (it) {
        if (prev) {
          var gap = it.x - (prev.x + (prev.w || 0));
          var spaced = /\s$/.test(prev.str) || /^\s/.test(it.str);
          if (!spaced) {
            if (gap > g.size * 1.5) text += '\t';
            else if (gap > g.size * 0.12) text += ' ';
          }
        }
        text += it.str; prev = it;
      });
      return { text: text.replace(/[ \t]+$/, ''), y: g.y, x0: g.items[0].x, size: g.size };
    }).filter(function (l) { return l.text.length; });
  }

  /** lines -> [{text, kind:'p'|'h1'|'h2'|'h3'}]  (headings by font size, paragraphs by vertical gap) */
  function toParagraphs(lines) {
    if (!lines.length) return [];
    var weights = {}, body = 10, best = -1;
    lines.forEach(function (l) { var k = Math.round(l.size * 2) / 2; weights[k] = (weights[k] || 0) + l.text.length; });
    Object.keys(weights).forEach(function (k) { if (weights[k] > best) { best = weights[k]; body = +k; } });
    var paras = [], cur = null, prev = null;
    lines.forEach(function (l) {
      var r = l.size / body, kind = 'p';
      if (r >= 1.8) kind = 'h1'; else if (r >= 1.4) kind = 'h2'; else if (r >= 1.18 && l.text.length < 100) kind = 'h3';
      var bullet = /^([\u2022\u25aa\u25e6\u25cf\u25cb\u25a0*]|[-\u2013\u2014]\s|\d{1,3}[.)])\s*\S/.test(l.text) && /^([\u2022\u25aa\u25e6\u25cf\u25cb\u25a0*]|[-\u2013\u2014]|\d{1,3}[.)])\s/.test(l.text);
      var row = l.text.indexOf('\t') >= 0;
      var gap = prev ? (l.y - prev.y) : 0;
      var fresh = !prev || kind !== 'p' || prev.kind !== 'p' || bullet || row || prev.row || gap > 1.6 * Math.max(prev.size, l.size);
      if (fresh) { cur = { text: l.text, kind: kind }; paras.push(cur); }
      else cur.text += (/-$/.test(cur.text) ? '' : ' ') + l.text;
      prev = { y: l.y, size: l.size, kind: kind, row: row };
    });
    return paras;
  }

  /** pages: [{num, lines}]  opts: {mode:'lines'|'paragraphs', mark:boolean} */
  function textFromPages(pages, o) {
    o = o || {};
    var out = [];
    pages.forEach(function (pg, i) {
      var body = o.mode === 'paragraphs'
        ? toParagraphs(pg.lines).map(function (p) { return p.text; }).join('\n\n')
        : pg.lines.map(function (l) { return l.text; }).join('\n');
      if (o.mark) out.push((i ? '\n\n' : '') + '----- Page ' + pg.num + ' -----\n\n' + body);
      else out.push(body);
    });
    return o.mark ? out.join('') : out.join('\n\n');
  }

  /** "1-3, 5, 8-" -> {pages:[0,1,2,4,7...]} (0-based) or {error} */
  function parseRanges(str, n) {
    var s = String(str == null ? '' : str).trim().toLowerCase(), pages = [], seen = {};
    function add(a, b) { for (var p = a; p <= b; p++) if (!seen[p]) { seen[p] = 1; pages.push(p - 1); } }
    if (!s || s === 'all') { add(1, n); return { pages: pages }; }
    var parts = s.split(/\s*,\s*/);
    for (var i = 0; i < parts.length; i++) {
      var m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(parts[i]);
      if (!m || (!m[1] && !m[3])) return { error: 'Could not understand "' + parts[i] + '". Use something like 1-3, 5, 8-' };
      var a, b;
      if (!m[2]) { a = b = +m[1]; }
      else { a = m[1] ? +m[1] : 1; b = m[3] ? +m[3] : n; }
      if (a < 1 || b > n || a > b) return { error: 'Pages ' + parts[i] + ' are outside this document, which has ' + n + (n === 1 ? ' page.' : ' pages.') };
      add(a, b);
    }
    return { pages: pages };
  }

  /* ------------------------------------------------------------------ */
  /* Images: sniffing, JPEG metadata                                     */
  /* ------------------------------------------------------------------ */
  function sniffImage(b) {
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0D && b[5] === 0x0A) return 'png';
    if (ascii(b, 0, 4) === 'GIF8') return 'gif';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (ascii(b, 0, 2) === 'BM') return 'bmp';
    if (ascii(b, 4, 4) === 'ftyp') {
      var brand = ascii(b, 8, 4);
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
      if (/^avi[fs]$/.test(brand)) return 'avif';
    }
    return 'unknown';
  }
  function pngSize(b) { return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 }; }

  function tiffInfo(b, t, end) {
    var le = ascii(b, t, 2) === 'II';
    if (!le && ascii(b, t, 2) !== 'MM') return null;
    function r16(o) { return o + 2 > end ? 0 : (le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1])); }
    function r32(o) { return o + 4 > end ? 0 : (le ? u32(b, o) : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0)); }
    var ifd = t + r32(t + 4), res = { orientation: 1, hasGps: false };
    var n = r16(ifd);
    for (var i = 0; i < n && i < 200; i++) {
      var e = ifd + 2 + 12 * i;
      if (e + 12 > end) break;
      var tag = r16(e);
      if (tag === 0x0112) { var v = r16(e + 8); if (v >= 1 && v <= 8) res.orientation = v; }
      else if (tag === 0x8825) {
        var g = t + r32(e + 8), gn = r16(g);
        for (var k = 0; k < gn && k < 64; k++) { var gt = r16(g + 2 + 12 * k); if (gt === 2 || gt === 4) res.hasGps = true; }
      }
    }
    return res;
  }

  function jpegWalk(b) {
    if (!(b.length > 3 && b[0] === 0xFF && b[1] === 0xD8)) return null;
    var segs = [], i = 2, w = 0, h = 0, sos = -1;
    while (i + 3 < b.length) {
      if (b[i] !== 0xFF) break;
      var mk = b[i + 1];
      if (mk === 0xFF) { i++; continue; }
      if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
      if (mk === 0xD9) break;
      if (mk === 0xDA) { sos = i; break; }
      var len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2 || i + 2 + len > b.length) break;
      segs.push({ marker: mk, start: i, end: i + 2 + len });
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) { h = (b[i + 5] << 8) | b[i + 6]; w = (b[i + 7] << 8) | b[i + 8]; }
      i += 2 + len;
    }
    return { segs: segs, sos: sos, width: w, height: h };
  }

  /** -> {valid, width, height, orientation, hasExif, hasGps, hasXmp, hasOther} */
  function jpegInfo(b) {
    var j = jpegWalk(b);
    if (!j) return { valid: false, orientation: 1, hasExif: false, hasGps: false, hasXmp: false, hasOther: false };
    var info = { valid: true, width: j.width, height: j.height, orientation: 1, hasExif: false, hasGps: false, hasXmp: false, hasOther: false };
    j.segs.forEach(function (s) {
      var p = s.start + 4;
      if (s.marker === 0xE1) {
        if (ascii(b, p, 6) === 'Exif\0\0') {
          info.hasExif = true;
          var t = tiffInfo(b, p + 6, s.end);
          if (t) { info.orientation = t.orientation; info.hasGps = t.hasGps; }
        } else if (ascii(b, p, 28).indexOf('http://ns.adobe.com/xap/1.0/') === 0) info.hasXmp = true;
      } else if (s.marker === 0xED || s.marker === 0xFE) info.hasOther = true;
    });
    return info;
  }

  /** Lossless: drops APP1 (EXIF/XMP), APP13, comments and other APPn. Keeps APP0, ICC colour profile and Adobe APP14. */
  function stripJpegMetadata(b) {
    var j = jpegWalk(b);
    if (!j || j.sos < 0) return { bytes: b, removed: [], removedBytes: 0 };
    var chunks = [b.subarray(0, 2)], removed = [], removedBytes = 0;
    j.segs.forEach(function (s) {
      var m = s.marker, drop = false;
      if (m === 0xFE) drop = true;
      else if (m >= 0xE1 && m <= 0xEF && m !== 0xEE) {
        drop = !(m === 0xE2 && ascii(b, s.start + 4, 12) === 'ICC_PROFILE\0');
      }
      if (drop) {
        removedBytes += s.end - s.start;
        removed.push(m === 0xE1 ? (ascii(b, s.start + 4, 4) === 'Exif' ? 'EXIF' : 'XMP') : m === 0xFE ? 'comment' : 'APP' + (m - 0xE0));
      } else chunks.push(b.subarray(s.start, s.end));
    });
    if (!removed.length) return { bytes: b, removed: [], removedBytes: 0 };
    chunks.push(b.subarray(j.sos));
    return { bytes: concat(chunks), removed: removed, removedBytes: removedBytes };
  }

  /* ------------------------------------------------------------------ */
  /* PDF output: fonts, safe text, wrapping, page flow                   */
  /* ------------------------------------------------------------------ */
  var SUBS = { '\u2212': '-', '\u2011': '-', '\u2192': '->', '\u2190': '<-', '\u2265': '>=', '\u2264': '<=', '\u2022': '\u2022' };

  function makeSafe(font) {
    var cache = {}, st = { replaced: 0 };
    st.fix = function (s) {
      s = String(s).replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
      var res = '';
      Array.from(s).forEach(function (ch) {
        if (ch === '\n') { res += ch; return; }
        if (SUBS[ch]) ch = SUBS[ch];
        var ok = cache[ch];
        if (ok === undefined) { try { font.widthOfTextAtSize(ch, 10); ok = true; } catch (e) { ok = false; } cache[ch] = ok; }
        if (ok) res += ch; else { res += '?'; st.replaced++; }
      });
      return res;
    };
    return st;
  }

  async function embedFonts(out, PDFLib, family) {
    var S = PDFLib.StandardFonts;
    var names = {
      Helvetica: [S.Helvetica, S.HelveticaBold], Times: [S.TimesRoman, S.TimesRomanBold], Courier: [S.Courier, S.CourierBold]
    }[family] || [S.Helvetica, S.HelveticaBold];
    return { r: await out.embedFont(names[0]), b: await out.embedFont(names[1]) };
  }

  function setMeta(out, o) {
    if (o.scrub) return;
    var d = new Date();
    out.setProducer('Quanttum PDF'); out.setCreator('Quanttum PDF');
    out.setCreationDate(d); out.setModificationDate(d);
    if (o.title) out.setTitle(o.title);
  }

  /** Wrap text (already made safe) to maxW. Keeps indentation and blank lines; breaks overlong words by character. */
  function wrap(text, font, size, maxW) {
    var out = [];
    String(text).split('\n').forEach(function (para) {
      var toks = para.match(/\s+|\S+/g) || [''], line = '', w = 0;
      toks.forEach(function (tk) {
        var tw = font.widthOfTextAtSize(tk, size), sp = /^\s/.test(tk);
        if (w + tw <= maxW) { line += tk; w += tw; return; }
        if (sp) { out.push(line); line = ''; w = 0; return; }
        if (line) { out.push(line.replace(/\s+$/, '')); line = ''; w = 0; }
        if (tw <= maxW) { line = tk; w = tw; return; }
        var seg = '', sw = 0;
        Array.from(tk).forEach(function (ch) {
          var cw = font.widthOfTextAtSize(ch, size);
          if (sw + cw > maxW && seg) { out.push(seg); seg = ''; sw = 0; }
          seg += ch; sw += cw;
        });
        line = seg; w = sw;
      });
      out.push(line);
    });
    return out;
  }

  function makeFlow(out, o) {
    var P = PAGE[o.pageSize] || PAGE.a4, T = { W: P[0], H: P[1], m: o.margin, pages: [], page: null, y: 0 };
    T.newPage = function () { T.page = out.addPage([T.W, T.H]); T.pages.push(T.page); T.y = T.H - T.m; return T.page; };
    T.need = function (h) { if (!T.page || T.y - h < T.m - 0.01) T.newPage(); };
    T.atTop = function () { return !T.page || T.y >= T.H - T.m - 0.5; };
    T.breakPage = function () { if (!T.atTop()) T.newPage(); else if (!T.page) T.newPage(); };
    return T;
  }

  /** o: {PDFLib, text, font, size, pageSize, margin, pageNumbers, scrub, title} -> {bytes, pages, replaced} */
  async function textToPdf(o) {
    var PDFLib = o.PDFLib, out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    setMeta(out, o);
    var F = await embedFonts(out, PDFLib, o.font), safe = makeSafe(F.r);
    var T = makeFlow(out, o), size = o.size || 11, lh = size * 1.35, maxW = T.W - 2 * T.m, black = PDFLib.rgb(0, 0, 0);
    String(o.text).replace(/^\ufeff/, '').split('\f').forEach(function (chunk, ci) {
      if (ci > 0) T.newPage();
      safe.fix(chunk).split('\n').forEach(function (line) {
        wrap(line, F.r, size, maxW).forEach(function (ln) {
          T.need(lh);
          if (ln.trim()) T.page.drawText(ln, { x: T.m, y: T.y - size * 0.85, size: size, font: F.r, color: black });
          T.y -= lh;
        });
      });
    });
    if (!T.pages.length) T.newPage();
    if (o.pageNumbers) {
      var hv = await out.embedFont(PDFLib.StandardFonts.Helvetica), n = T.pages.length;
      T.pages.forEach(function (pg, i) {
        var s = (i + 1) + ' / ' + n, w = hv.widthOfTextAtSize(s, 9);
        pg.drawText(s, { x: (T.W - w) / 2, y: Math.max(12, T.m / 2 - 4), size: 9, font: hv, color: PDFLib.rgb(0.4, 0.4, 0.4) });
      });
    }
    return { bytes: await out.save(), pages: T.pages.length, replaced: safe.replaced };
  }

  /** o: {PDFLib, blocks, font, size, pageSize, margin, scrub, title} -> {bytes, pages, replaced} */
  async function docxToPdf(o) {
    var PDFLib = o.PDFLib, out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    setMeta(out, o);
    var F = await embedFonts(out, PDFLib, o.font), safe = makeSafe(F.r);
    var T = makeFlow(out, o), base = o.size || 11, black = PDFLib.rgb(0, 0, 0), gray = PDFLib.rgb(0.6, 0.6, 0.6);
    var contentW = T.W - 2 * T.m;

    function drawPara(b) {
      var kind = b.kind, size = { title: base * 2.2, h1: base * 1.8, h2: base * 1.45, h3: base * 1.2 }[kind] || base;
      var bold = kind !== 'p' || b.bold, font = bold ? F.b : F.r, lh = size * 1.25;
      var before = kind !== 'p' ? size * 0.6 : 0, after = kind !== 'p' ? size * 0.3 : base * 0.55;
      var indent = b.list ? 18 : 0;
      if (b.pageBreakBefore) T.breakPage();
      String(b.text).split('\f').forEach(function (seg, si) {
        if (si > 0) T.newPage();
        var lines = wrap(safe.fix(seg), font, size, contentW - indent);
        if (!T.atTop()) T.y -= before;
        if (kind !== 'p') T.need(lh * 3);
        lines.forEach(function (ln, li) {
          T.need(lh);
          var text = ln.replace(/\s+$/, ''), tw = font.widthOfTextAtSize(text, size), x = T.m + indent;
          if (b.align === 'center') x = T.m + indent + (contentW - indent - tw) / 2;
          else if (b.align === 'right') x = T.m + contentW - tw;
          var base_y = T.y - size * 0.85;
          if (b.list && li === 0 && si === 0) T.page.drawText('\u2022', { x: T.m + 4, y: base_y, size: size, font: F.r, color: black });
          if (text) T.page.drawText(text, { x: x, y: base_y, size: size, font: font, color: black });
          T.y -= lh;
        });
        T.y -= after;
      });
    }

    function drawTable(rows) {
      var cols = 0; rows.forEach(function (r) { cols = Math.max(cols, r.length); });
      if (!cols) return;
      var cw = contentW / cols, size = base * 0.9, lh = size * 1.25, pad = 4;
      if (!T.atTop()) T.y -= base * 0.3;
      rows.forEach(function (row) {
        var cells = [], total = 0, c;
        for (c = 0; c < cols; c++) { var w = wrap(safe.fix(row[c] || ''), F.r, size, cw - 2 * pad); cells.push(w); total = Math.max(total, w.length); }
        var idx = 0;
        while (idx < total) {
          T.need(lh + 2 * pad);
          var avail = T.y - T.m - 2 * pad, n = Math.min(Math.max(1, Math.floor(avail / lh)), total - idx), h = n * lh + 2 * pad;
          for (c = 0; c < cols; c++) {
            T.page.drawRectangle({ x: T.m + c * cw, y: T.y - h, width: cw, height: h, borderColor: gray, borderWidth: 0.5 });
            cells[c].slice(idx, idx + n).forEach(function (ln, i) {
              if (ln.trim()) T.page.drawText(ln.replace(/\s+$/, ''), { x: T.m + c * cw + pad, y: T.y - pad - size * 0.85 - i * lh, size: size, font: F.r, color: black });
            });
          }
          T.y -= h; idx += n;
        }
      });
      T.y -= base * 0.6;
    }

    (o.blocks || []).forEach(function (b) { if (b.type === 'table') drawTable(b.rows); else drawPara(b); });
    if (!T.pages.length) T.newPage();
    return { bytes: await out.save(), pages: T.pages.length, replaced: safe.replaced };
  }

  /** o: {PDFLib, images:[{bytes, mime, w, h}], pageSize:'fit'|'a4'|'letter', margin, scrub, title, reencode(img)->{bytes,mime,w,h}} */
  async function imagesToPdf(o) {
    var PDFLib = o.PDFLib, out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    setMeta(out, o);
    for (var i = 0; i < o.images.length; i++) {
      var img = o.images[i], emb;
      try {
        emb = img.mime === 'image/jpeg' ? await out.embedJpg(img.bytes) : await out.embedPng(img.bytes);
      } catch (err) {
        if (!o.reencode) throw err;
        var r = await o.reencode(img);
        emb = r.mime === 'image/jpeg' ? await out.embedJpg(r.bytes) : await out.embedPng(r.bytes);
        img = r;
      }
      var w = img.w || emb.width, h = img.h || emb.height, page;
      if (o.pageSize === 'a4' || o.pageSize === 'letter') {
        var P = PAGE[o.pageSize], pw = w > h ? P[1] : P[0], ph = w > h ? P[0] : P[1], m = o.margin || 0;
        var s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h), dw = w * s, dh = h * s;
        page = out.addPage([pw, ph]);
        page.drawImage(emb, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      } else {
        var sc = Math.min(0.75, 841.89 / Math.max(w, h));
        page = out.addPage([w * sc, h * sc]);
        page.drawImage(emb, { x: 0, y: 0, width: w * sc, height: h * sc });
      }
    }
    return { bytes: await out.save(), pages: o.images.length };
  }

  function safeBase(name) {
    var b = String(name || 'document').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    return b || 'document';
  }

  return {
    zipStore: zipStore, zipRead: zipRead, crc32: crc32,
    parseDocxXml: parseDocxXml, readDocx: readDocx, buildDocx: buildDocx,
    layoutLines: layoutLines, toParagraphs: toParagraphs, textFromPages: textFromPages, parseRanges: parseRanges,
    sniffImage: sniffImage, pngSize: pngSize, jpegInfo: jpegInfo, stripJpegMetadata: stripJpegMetadata,
    textToPdf: textToPdf, docxToPdf: docxToPdf, imagesToPdf: imagesToPdf,
    wrap: wrap, makeSafe: makeSafe, safeBase: safeBase, xmlEscape: xmlEscape, xmlDecode: xmlDecode,
    embedFonts: embedFonts, setMeta: setMeta, concat: concat, PAGE: PAGE
  };
});
