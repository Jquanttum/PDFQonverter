/*  Quanttum PDF - sheets.js
 *  Pure logic for the spreadsheet conversions. No DOM. Runs in the browser (window.QSheets) and in Node (tests).
 *  Needs converter.js (zip reader/writer, XML helpers, PDF text helpers).
 *
 *  Covers: .xlsx reader (shared strings, styles, dates in the 1900 and 1904 systems, hidden sheets/rows/columns,
 *  formulas with and without stored results, comments, metadata), Excel-style number/date display, CSV parse/write,
 *  .xlsx writer, Excel -> PDF layout, and table detection from positioned PDF text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./converter.js'));
  else root.QSheets = factory(root.QConvert);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var dec = new TextDecoder('utf-8'), enc = new TextEncoder();
  var MAX_CELLS = 20e6;       // bounding box of a sheet we are willing to hold in memory
  var MAX_PDF_CELLS = 1.5e6;  // drawn cells per PDF
  var XL_MAX_ROWS = 1048576, XL_MAX_COLS = 16384, XL_MAX_TEXT = 32767;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIndex(L) { var n = 0; for (var i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64); return n - 1; }
  function parseRef(ref) { var m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref || ''); return m ? { r: +m[2] - 1, c: colIndex(m[1].toUpperCase()) } : null; }
  function attr(tag, name) {
    var m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag);
    return m ? C.xmlDecode(m[1] !== undefined ? m[1] : m[2]) : null;
  }
  function truthy(v) { return v === '1' || v === 'true'; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
  function tagText(xml, tag) {
    var m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml);
    return m ? C.xmlDecode(m[1]).trim() : '';
  }
  function argb(v) { return v && /^[0-9a-fA-F]{6,8}$/.test(v) ? v.slice(-6).toUpperCase() : null; }

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Excel serial -> calendar parts. 1900 system keeps Excel's fake 29 Feb 1900 (serial 60). */
  function serialToParts(serial, date1904) {
    var secs = Math.round(serial * 86400), day = Math.floor(secs / 86400), rem = secs - day * 86400, dt, y, mo, d, wd;
    if (!isFinite(secs)) return null;
    if (date1904) {
      dt = new Date(Date.UTC(1904, 0, 1) + day * 864e5);
    } else if (day < 0) {
      return null;
    } else if (day === 0) {
      return { y: 1900, mo: 1, d: 0, wd: 6, hh: Math.floor(rem / 3600), mi: Math.floor(rem % 3600 / 60), ss: rem % 60, secs: secs, day: 0 };
    } else if (day === 60) {
      return { y: 1900, mo: 2, d: 29, wd: 3, hh: Math.floor(rem / 3600), mi: Math.floor(rem % 3600 / 60), ss: rem % 60, secs: secs, day: 60 };
    } else if (day < 60) {
      dt = new Date(Date.UTC(1899, 11, 31) + day * 864e5);
    } else {
      dt = new Date(Date.UTC(1899, 11, 30) + day * 864e5);
    }
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate(); wd = dt.getUTCDay();
    return { y: y, mo: mo, d: d, wd: wd, hh: Math.floor(rem / 3600), mi: Math.floor(rem % 3600 / 60), ss: rem % 60, secs: secs, day: day };
  }

  /** Exact (machine-friendly) text for a date serial: 2026-03-14, 2026-03-14 16:30:42, or 16:30:42 for a time of day. */
  function isoFromSerial(serial, date1904) {
    var p = serialToParts(serial, date1904); if (!p) return '';
    var time = pad2(p.hh) + ':' + pad2(p.mi) + ':' + pad2(p.ss);
    if (serial >= 0 && serial < 1) return time;
    var date = String(p.y).padStart(4, '0') + '-' + pad2(p.mo) + '-' + pad2(p.d);
    return (p.hh || p.mi || p.ss) ? date + ' ' + time : date;
  }

  /** Date -> Excel serial in the 1900 system (valid from 1900-03-01). */
  function dateToSerial(y, mo, d, hh, mi, ss) {
    var days = (Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
    return days + ((hh || 0) * 3600 + (mi || 0) * 60 + (ss || 0)) / 86400;
  }

  /* ------------------------------------------------------------------ */
  /* Number formats                                                      */
  /* ------------------------------------------------------------------ */
  var BUILTIN = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;(#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;(#,##0.00)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@'
  };

  function stripCode(code) {
    return String(code || '').replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '')
      .replace(/\[[^\]]*\]/g, function (m) { return /^\[(h+|m+|s+)\]$/i.test(m) ? m.slice(1, -1) : ''; });
  }
  function isDateCode(code) {
    var s = stripCode(code);
    if (/^\s*general\s*$/i.test(s) || /^\s*@\s*$/.test(s)) return false;
    return /[dmyhs]/i.test(s.replace(/e[+-]/gi, ''));
  }

  function splitSections(code) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < code.length; i++) {
      var ch = code[i];
      if (ch === '"') { q = !q; cur += ch; }
      else if (ch === '\\' && !q) { cur += ch + (code[i + 1] || ''); i++; }
      else if (ch === ';' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** -> [{lit}|{pat}|{pct}] or null when the section is something we do not draw (fractions, text sections). */
  function numTokens(sec) {
    if (/\?\/[\d?]/.test(sec.replace(/"[^"]*"/g, ''))) return null;
    var toks = [], i = 0, n = sec.length, pat = '';
    function flush() { if (pat) { toks.push({ pat: pat }); pat = ''; } }
    while (i < n) {
      var ch = sec[i];
      if (ch === '"') { flush(); var j = sec.indexOf('"', i + 1); if (j < 0) j = n; toks.push({ lit: sec.slice(i + 1, j) }); i = j + 1; }
      else if (ch === '\\') { flush(); toks.push({ lit: sec[i + 1] || '' }); i += 2; }
      else if (ch === '_') { flush(); toks.push({ lit: ' ' }); i += 2; }
      else if (ch === '*') { i += 2; }
      else if (ch === '[') {
        flush(); var k = sec.indexOf(']', i); if (k < 0) k = n;
        var inner = sec.slice(i + 1, k);
        if (inner.charAt(0) === '$') toks.push({ lit: inner.slice(1).split('-')[0] });
        i = k + 1;
      }
      else if (ch === '%') { flush(); toks.push({ pct: true }); i++; }
      else if (ch === '@') { return null; }
      else if ('#0?'.indexOf(ch) >= 0) { pat += ch; i++; }
      else if ((ch === '.' || ch === ',') && (pat || '#0?'.indexOf(sec[i + 1] || '') >= 0)) { pat += ch; i++; }
      else if ((ch === 'E' || ch === 'e') && (sec[i + 1] === '+' || sec[i + 1] === '-') && pat) {
        pat += 'E' + sec[i + 1]; i += 2;
        while (i < n && (sec[i] === '0' || sec[i] === '#')) { pat += sec[i]; i++; }
      }
      else { flush(); toks.push({ lit: ch }); i++; }
    }
    flush();
    return toks;
  }

  function roundFixed(x, dec2) {
    var s = String(x);
    if (/e/i.test(s)) return x.toFixed(Math.min(dec2, 100));
    var r = Number(Math.round(Number(s + 'e' + dec2)) + 'e-' + dec2);
    if (!isFinite(r)) return x.toFixed(Math.min(dec2, 100));
    return r.toFixed(dec2);
  }

  function fmtGeneral(x) {
    if (!isFinite(x)) return String(x);
    if (x === 0) return '0';
    var a = Math.abs(x), s;
    if (a >= 1e11 || a < 1e-9) {
      s = x.toExponential(5).replace(/\.?0+e/, 'e');
      return s.replace(/e([+-])(\d)$/, 'e$10$2').toUpperCase();
    }
    if (Number.isInteger(x)) return String(x);
    // Excel's General format fits the number into 11 characters (sign, digits and point included)
    var intDigits = a >= 1 ? Math.floor(Math.log10(a)) + 1 : 1, places = Math.max(0, Math.min(15, 11 - (x < 0 ? 1 : 0) - intDigits - 1));
    s = a.toFixed(places);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return (x < 0 ? '-' : '') + s;
  }

  function renderPattern(ax, pat) {
    var sci = /^(.*?)E([+-])([0#]+)$/i.exec(pat);
    if (sci) {
      var mdot = sci[1].indexOf('.'), md = mdot < 0 ? 0 : sci[1].slice(mdot + 1).replace(/,/g, '').length;
      var ex = ax === 0 ? 'e+0' : ax.toExponential(md), parts = /^(.*)e([+-])(\d+)$/.exec(ex);
      var es = (parts[2] === '-' ? '-' : (sci[2] === '+' ? '+' : '')) + parts[3].padStart(sci[3].length, '0');
      return parts[1] + 'E' + es;
    }
    var dot = pat.indexOf('.'), intPat = dot < 0 ? pat : pat.slice(0, dot), decPat = dot < 0 ? '' : pat.slice(dot + 1).replace(/,/g, '');
    var trailing = (intPat.match(/,+$/) || [''])[0].length, thousands = /,/.test(intPat.replace(/,+$/, ''));
    intPat = intPat.replace(/,/g, '');
    if (trailing) ax = ax / Math.pow(1000, trailing);
    var s = roundFixed(ax, decPat.length), ip = s.split('.')[0], dp = s.split('.')[1] || '', minDec = (decPat.match(/0/g) || []).length;
    while (dp.length > minDec && dp.charAt(dp.length - 1) === '0') dp = dp.slice(0, -1);
    var minInt = (intPat.match(/0/g) || []).length;
    if (ip === '0' && minInt === 0) ip = '';
    ip = ip.padStart(minInt, '0');
    if (thousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return ip + (decPat.length ? '.' + dp : '');
  }

  function formatNumber(x, code) {
    if (!code || /^\s*general\s*$/i.test(code)) return fmtGeneral(x);
    var secs = splitSections(code), neg = x < 0, ax = Math.abs(x), sec, sign = false;
    if (neg && secs.length >= 2) sec = secs[1];
    else if (x === 0 && secs.length >= 3) sec = secs[2];
    else { sec = secs[0]; sign = neg; }
    var toks = numTokens(sec);
    if (!toks) return fmtGeneral(x);
    var hasPat = toks.some(function (t) { return t.pat !== undefined; });
    if (!hasPat) return toks.map(function (t) { return t.lit !== undefined ? t.lit : '%'; }).join('');
    toks.forEach(function (t) { if (t.pct) ax *= 100; });
    var body = toks.map(function (t) {
      if (t.lit !== undefined) return t.lit;
      if (t.pct) return '%';
      return renderPattern(ax, t.pat);
    }).join('');
    if (sign && !/[1-9]/.test(body)) sign = false;
    return (sign ? '-' : '') + body;
  }

  function dateTokens(code) {
    var toks = [], i = 0, n = code.length;
    while (i < n) {
      var ch = code[i], low = ch.toLowerCase(), rest;
      if (ch === '"') { var j = code.indexOf('"', i + 1); if (j < 0) j = n; toks.push({ lit: code.slice(i + 1, j) }); i = j + 1; }
      else if (ch === '\\') { toks.push({ lit: code[i + 1] || '' }); i += 2; }
      else if (ch === '_') { toks.push({ lit: ' ' }); i += 2; }
      else if (ch === '*') { i += 2; }
      else if (ch === '[') {
        var k = code.indexOf(']', i); if (k < 0) k = n;
        var inner = code.slice(i + 1, k);
        if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ el: inner.charAt(0).toLowerCase(), n: inner.length });
        i = k + 1;
      }
      else if (/[ymdhs]/i.test(ch)) { var j2 = i; while (j2 < n && code[j2].toLowerCase() === low) j2++; toks.push({ u: low, n: j2 - i }); i = j2; }
      else if ((rest = /^(am\/pm|a\/p)/i.exec(code.slice(i)))) { toks.push({ ap: rest[0] }); i += rest[0].length; }
      else if (ch === '.' && code[i + 1] === '0') { var j3 = i + 1; while (code[j3] === '0') j3++; toks.push({ frac: j3 - i - 1 }); i = j3; }
      else { toks.push({ lit: ch }); i++; }
    }
    return toks;
  }

  function formatDate(serial, code, date1904) {
    var p = serialToParts(serial, date1904);
    if (!p) return '########';
    var toks = dateTokens(stripSection(code)), hasAP = toks.some(function (t) { return t.ap !== undefined; });
    toks.forEach(function (t, idx) {
      if (t.u !== 'm') return;
      var a = idx - 1, b = idx + 1;
      while (a >= 0 && toks[a].lit !== undefined) a--;
      while (b < toks.length && toks[b].lit !== undefined) b++;
      var prev = toks[a], next = toks[b];
      t.min = !!((prev && (prev.u === 'h' || prev.el === 'h')) || (next && (next.u === 's' || next.el === 's')));
    });
    return toks.map(function (t) {
      if (t.lit !== undefined) return t.lit;
      if (t.frac !== undefined) return '';
      if (t.ap !== undefined) { var pm = p.hh >= 12, slash = t.ap.toUpperCase() === 'A/P'; return slash ? (pm ? 'P' : 'A') : (pm ? 'PM' : 'AM'); }
      if (t.el) { var tot = t.el === 'h' ? Math.floor(p.secs / 3600) : t.el === 'm' ? Math.floor(p.secs / 60) : p.secs; return String(tot).padStart(t.n, '0'); }
      switch (t.u) {
        case 'y': return t.n <= 2 ? pad2(p.y % 100) : String(p.y).padStart(4, '0');
        case 'm':
          if (t.min) return t.n >= 2 ? pad2(p.mi) : String(p.mi);
          if (t.n === 1) return String(p.mo); if (t.n === 2) return pad2(p.mo);
          if (t.n === 3) return MONTHS[p.mo - 1].slice(0, 3); if (t.n === 4) return MONTHS[p.mo - 1];
          return MONTHS[p.mo - 1].charAt(0);
        case 'd':
          if (t.n === 1) return String(p.d); if (t.n === 2) return pad2(p.d);
          return t.n === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
        case 'h': var h = hasAP ? (p.hh % 12 || 12) : p.hh; return t.n >= 2 ? pad2(h) : String(h);
        case 's': return t.n >= 2 ? pad2(p.ss) : String(p.ss);
      }
      return '';
    }).join('');
  }
  function stripSection(code) { return splitSections(code)[0]; }

  /** Text as Excel would show it. cell: {k, v, ...}; info: style info for the cell. */
  function formatCell(cell, info, date1904) {
    if (!cell) return '';
    switch (cell.k) {
      case 's': case 'e': return String(cell.v);
      case 'b': return cell.v ? 'TRUE' : 'FALSE';
      case 'n':
        if (info && info.isDate) return formatDate(cell.v, info.code, date1904);
        return formatNumber(cell.v, info ? info.code : 'General');
    }
    return '';
  }
  function exactNumber(v) { return String(parseFloat(Number(v).toPrecision(15))); }

  /* ------------------------------------------------------------------ */
  /* Reading .xlsx                                                       */
  /* ------------------------------------------------------------------ */
  function sniffWorkbook(b) {
    if (b.length > 4 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
      return 'This is an older Excel file (.xls) or a password-protected workbook. Open it in Excel and save it as .xlsx without a password, then try again.';
    }
    if (!(b[0] === 0x50 && b[1] === 0x4B)) return 'That is not an Excel (.xlsx) file.';
    return '';
  }

  function parseStyles(xml) {
    var numFmts = {}, fonts = [], fills = [], xfs = [], m;
    (xml.match(/<numFmt\b[^>]*>/g) || []).forEach(function (t) { numFmts[attr(t, 'numFmtId')] = attr(t, 'formatCode'); });
    m = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(xml);
    if (m) (m[1].match(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g) || []).forEach(function (f) {
      var b = /<b\b([^>]*?)\/?>/.exec(f), col = /<color\b([^>]*?)\/?>/.exec(f), sz = /<sz\b([^>]*?)\/?>/.exec(f);
      var bv = b ? attr(' ' + b[1], 'val') : null;
      fonts.push({ bold: !!b && bv !== '0' && bv !== 'false', color: col ? argb(attr(' ' + col[1], 'rgb')) : null, size: sz ? parseFloat(attr(' ' + sz[1], 'val')) || null : null });
    });
    m = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml);
    if (m) (m[1].match(/<fill\b[^>]*?(?:\/>|>[\s\S]*?<\/fill>)/g) || []).forEach(function (f) {
      var pf = /<patternFill\b([^>]*?)(?:\/>|>)/.exec(f), fg = /<fgColor\b([^>]*?)\/?>/.exec(f);
      var type = pf ? attr(' ' + pf[1], 'patternType') : null;
      fills.push({ rgb: type === 'solid' && fg ? argb(attr(' ' + fg[1], 'rgb')) : null });
    });
    m = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (m) (m[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || []).forEach(function (x) {
      var head = /<xf\b([^>]*?)(?:\/>|>)/.exec(x)[1], al = /<alignment\b([^>]*?)\/?>/.exec(x);
      var id = attr(' ' + head, 'numFmtId') || '0', code = numFmts[id] != null ? numFmts[id] : (BUILTIN[id] != null ? BUILTIN[id] : 'General');
      var font = fonts[+attr(' ' + head, 'fontId')] || {}, fill = fills[+attr(' ' + head, 'fillId')] || {};
      var isDate = (+id >= 14 && +id <= 22) || (+id >= 45 && +id <= 47) || isDateCode(code);
      xfs.push({
        code: code, isDate: isDate, bold: !!font.bold, color: font.color || null, fontSize: font.size || null, fill: fill.rgb || null,
        align: al ? attr(' ' + al[1], 'horizontal') : null, wrap: al ? truthy(attr(' ' + al[1], 'wrapText')) : false
      });
    });
    return xfs;
  }

  function parseSharedStrings(xml) {
    var out = [];
    (xml.match(/<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g) || []).forEach(function (si) {
      si = si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      var s = '', re = /<t\b[^>]*>([\s\S]*?)<\/t>/g, m;
      while ((m = re.exec(si)) !== null) s += m[1];
      out.push(C.xmlDecode(s));
    });
    return out;
  }

  function parseSheetXml(xml, ctx) {
    var rowsArr = [], rowMeta = [], maxR = -1, maxC = -1, formulas = 0, noResult = 0, merges = [], colInfo = [];
    var sfp = /<sheetFormatPr\b[^>]*>/.exec(xml), defW = sfp ? parseFloat(attr(sfp[0], 'defaultColWidth')) : NaN;
    var colsM = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml);
    if (colsM) (colsM[1].match(/<col\b[^>]*>/g) || []).forEach(function (t) {
      var a = Math.max(1, parseInt(attr(t, 'min'), 10) || 1), b = Math.min(XL_MAX_COLS, parseInt(attr(t, 'max'), 10) || a);
      var w = parseFloat(attr(t, 'width')), info = { width: isNaN(w) ? null : w, custom: truthy(attr(t, 'customWidth')), hidden: truthy(attr(t, 'hidden')) };
      for (var c = a - 1; c < b; c++) colInfo[c] = info;
    });
    (xml.match(/<mergeCell\b[^>]*>/g) || []).forEach(function (t) {
      var ref = (attr(t, 'ref') || '').split(':'), a = parseRef(ref[0]), z = parseRef(ref[1] || ref[0]);
      if (a && z) merges.push({ r0: a.r, c0: a.c, r1: z.r, c1: z.c });
    });
    var sd = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml), body = sd ? sd[1] : '';
    var rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rm, nextRow = 0;
    while ((rm = rowRe.exec(body)) !== null) {
      var rr = parseInt(attr(rm[1], 'r'), 10), r = isNaN(rr) ? nextRow : rr - 1; nextRow = r + 1;
      var ht = parseFloat(attr(rm[1], 'ht'));
      rowMeta[r] = { hidden: truthy(attr(rm[1], 'hidden')), ht: isNaN(ht) ? null : ht, custom: truthy(attr(rm[1], 'customHeight')) };
      if (!rm[2]) continue;
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm, nextCol = 0;
      while ((cm = cellRe.exec(rm[2])) !== null) {
        var ref = parseRef(attr(cm[1], 'r')), c = ref ? ref.c : nextCol; nextCol = c + 1;
        var inner = cm[2] || '', t = attr(cm[1], 't') || 'n', s = parseInt(attr(cm[1], 's'), 10) || 0;
        var fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner), vm = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inner);
        var f = fm ? C.xmlDecode(fm[2] || '') : '', hasF = !!fm, vtxt = vm && vm[1] !== undefined ? vm[1] : '', cell = null;
        if (t === 'inlineStr') {
          var is = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), sx = '', tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g, tm;
          while ((tm = tre.exec(is)) !== null) sx += tm[1];
          cell = { k: 's', v: C.xmlDecode(sx) };
        } else if (t === 's') {
          var si = parseInt(vtxt, 10); cell = isNaN(si) ? null : { k: 's', v: ctx.sst[si] != null ? ctx.sst[si] : '' };
        } else if (t === 'str') {
          cell = (vm || !hasF) ? { k: 's', v: C.xmlDecode(vtxt) } : null;
        } else if (t === 'b') {
          cell = vm ? { k: 'b', v: truthy(vtxt) } : null;
        } else if (t === 'e') {
          cell = vm ? { k: 'e', v: C.xmlDecode(vtxt) } : null;
        } else if (t === 'd') {
          cell = vm ? { k: 's', v: C.xmlDecode(vtxt) } : null;
        } else if (vtxt !== '') {
          var num = Number(vtxt); cell = isNaN(num) ? null : { k: 'n', v: num };
        }
        if (hasF) { formulas++; if (!cell) noResult++; }
        if (!cell) {
          if (!hasF) continue;
          cell = { k: 'x', v: '' };
        }
        cell.s = s; cell.f = f; cell.hasF = hasF;
        (rowsArr[r] || (rowsArr[r] = []))[c] = cell;
        if (r > maxR) maxR = r; if (c > maxC) maxC = c;
      }
    }
    if ((maxR + 1) * (maxC + 1) > MAX_CELLS) throw new Error('A sheet in this workbook is too large to convert here (its used area is ' + (maxR + 1).toLocaleString() + ' rows by ' + (maxC + 1).toLocaleString() + ' columns).');
    var hiddenRows = 0, hiddenCols = 0, r2, c2;
    for (r2 = 0; r2 <= maxR; r2++) if (rowMeta[r2] && rowMeta[r2].hidden) hiddenRows++;
    for (c2 = 0; c2 <= maxC; c2++) if (colInfo[c2] && colInfo[c2].hidden) hiddenCols++;
    return {
      rows: rowsArr, rowMeta: rowMeta, colInfo: colInfo, merges: merges, nRows: maxR + 1, nCols: maxC + 1,
      defaultColWidth: isNaN(defW) ? null : defW, formulas: formulas, noResult: noResult, hiddenRows: hiddenRows, hiddenCols: hiddenCols
    };
  }

  /**  -> { sheets:[{name,state,rows,...}], date1904, styles, meta, comments, externalLinks, macros, definedNames } */
  async function readXlsx(bytes) {
    var problem = sniffWorkbook(bytes);
    if (problem) throw new Error(problem);
    var zip;
    try { zip = C.zipRead(bytes); } catch (e) { throw new Error('This file could not be opened as an Excel workbook (' + e.message + ').'); }
    if (zip.has('xl/workbook.bin')) throw new Error('This is a binary workbook (.xlsb). Open it in Excel and save it as .xlsx, then try again.');
    if (!zip.has('xl/workbook.xml')) throw new Error('This zip file is not an Excel workbook (it has no xl/workbook.xml).');
    var text = async function (n) { return zip.has(n) ? dec.decode(await zip.get(n)) : ''; };
    var wbXml = await text('xl/workbook.xml'), relXml = await text('xl/_rels/workbook.xml.rels');
    var rels = {};
    (relXml.match(/<Relationship\b[^>]*>/g) || []).forEach(function (t) {
      var tg = attr(t, 'Target') || '';
      tg = tg.charAt(0) === '/' ? tg.slice(1) : 'xl/' + tg;
      var parts = [];
      tg.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
      rels[attr(t, 'Id')] = parts.join('/');
    });
    var wpr = /<workbookPr\b[^>]*>/.exec(wbXml), date1904 = !!wpr && truthy(attr(wpr[0], 'date1904'));
    var styles = parseStyles(await text('xl/styles.xml')), sst = parseSharedStrings(await text('xl/sharedStrings.xml'));
    var sheets = [], sheetTags = wbXml.match(/<sheet\b[^>]*>/g) || [];
    for (var i = 0; i < sheetTags.length; i++) {
      var t = sheetTags[i], rid = attr(t, 'r:id'), path = rels[rid], st = attr(t, 'state') || 'visible';
      if (!path || !zip.has(path)) throw new Error('The sheet "' + attr(t, 'name') + '" is missing from the file, so the workbook looks damaged.');
      var sh = parseSheetXml(dec.decode(await zip.get(path)), { sst: sst });
      sh.name = attr(t, 'name') || ('Sheet' + (i + 1)); sh.state = st; sh.path = path;
      sheets.push(sh);
    }
    var comments = 0, externalLinks = 0, k, names = zip.names;
    for (k = 0; k < names.length; k++) {
      if (/(^|\/)comments\d*\.xml$/.test(names[k])) comments += (dec.decode(await zip.get(names[k])).match(/<comment\b/g) || []).length;
      else if (/^xl\/threadedComments\/.*\.xml$/.test(names[k])) comments += (dec.decode(await zip.get(names[k])).match(/<threadedComment\b/g) || []).length;
      else if (/^xl\/externalLinks\/[^/]+\.xml$/.test(names[k])) externalLinks++;
    }
    var core = await text('docProps/core.xml'), app = await text('docProps/app.xml');
    return {
      sheets: sheets, date1904: date1904, styles: styles, comments: comments, externalLinks: externalLinks,
      macros: zip.has('xl/vbaProject.bin'), definedNames: (wbXml.match(/<definedName\b/g) || []).length,
      meta: {
        creator: tagText(core, 'dc:creator'), lastModifiedBy: tagText(core, 'cp:lastModifiedBy'),
        created: tagText(core, 'dcterms:created'), modified: tagText(core, 'dcterms:modified'),
        application: tagText(app, 'Application'), appVersion: tagText(app, 'AppVersion'), company: tagText(app, 'Company')
      }
    };
  }

  function styleOf(wb, cell) { return cell ? (wb.styles[cell.s] || null) : null; }

  /** Things worth knowing before a spreadsheet is converted. [{level:'warn'|'info', text}] */
  function workbookFindings(wb) {
    var out = [], hiddenS = wb.sheets.filter(function (s) { return s.state !== 'visible'; });
    if (hiddenS.length) {
      out.push({ level: 'warn', text: plural(hiddenS.length, 'sheet is', 'sheets are') + ' hidden: ' + hiddenS.map(function (s) { return '"' + s.name + '"' + (s.state === 'veryHidden' ? ' (very hidden: it cannot be unhidden from Excel\u2019s normal menu)' : ''); }).join(', ') + '.' });
    }
    var hr = 0, hc = 0, fm = 0, nr = 0;
    wb.sheets.forEach(function (s) { hr += s.hiddenRows; hc += s.hiddenCols; fm += s.formulas; nr += s.noResult; });
    if (hr || hc) out.push({ level: 'warn', text: (hr ? plural(hr, 'row is', 'rows are') + ' hidden (by hand or by a filter)' : '') + (hr && hc ? ' and ' : '') + (hc ? plural(hc, 'column is', 'columns are') + ' hidden' : '') + '.' });
    if (nr) out.push({ level: 'warn', text: plural(nr, 'formula has', 'formulas have') + ' no stored result. The file was written by a program and never calculated in Excel, so those cells come out empty. Open and save it in Excel once to store the results.' });
    else if (fm) out.push({ level: 'info', text: plural(fm, 'cell contains a formula', 'cells contain formulas') + '. Results are the values stored in the file when it was last saved.' });
    if (wb.comments) out.push({ level: 'info', text: plural(wb.comments, 'cell comment or note', 'cell comments or notes') + ' in the workbook. They are not carried into the converted file.' });
    if (wb.macros) out.push({ level: 'warn', text: 'The workbook contains macros (VBA). They are ignored and never run.' });
    if (wb.externalLinks) out.push({ level: 'info', text: 'The workbook links to ' + plural(wb.externalLinks, 'other workbook', 'other workbooks') + '. Linked cells show the values stored in this file.' });
    if (wb.date1904) out.push({ level: 'info', text: 'This workbook uses the 1904 date system (common in files from older Mac Excel). Dates are converted correctly, but copying them into a 1900-system workbook shifts them by four years and one day.' });
    var m = wb.meta, c = Date.parse(m.created), d = Date.parse(m.modified);
    if (!isNaN(c) && !isNaN(d) && d < c) out.push({ level: 'warn', text: 'The workbook\u2019s modified date is earlier than its created date.' });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Workbook -> table of strings (CSV)                                  */
  /* ------------------------------------------------------------------ */
  /** o: {includeHidden, formulas, display, protect} -> {rows, skippedRows, skippedCols, protectedCells} */
  function sheetToRows(sh, wb, o) {
    o = o || {};
    var rows = [], skippedRows = 0, skippedCols = 0, prot = 0, cols = [], c, r;
    for (c = 0; c < sh.nCols; c++) { if (!o.includeHidden && sh.colInfo[c] && sh.colInfo[c].hidden) skippedCols++; else cols.push(c); }
    for (r = 0; r < sh.nRows; r++) {
      if (!o.includeHidden && sh.rowMeta[r] && sh.rowMeta[r].hidden) { skippedRows++; continue; }
      var src = sh.rows[r] || [], out = [];
      for (var k = 0; k < cols.length; k++) {
        var cell = src[cols[k]], txt = '', isText = false;
        if (cell) {
          if (o.formulas && cell.f) { txt = '=' + cell.f; isText = true; }
          else if (cell.k === 's') { txt = String(cell.v); isText = true; }
          else if (cell.k === 'b') txt = cell.v ? 'TRUE' : 'FALSE';
          else if (cell.k === 'e') txt = String(cell.v);
          else if (cell.k === 'n') {
            var info = styleOf(wb, cell);
            if (o.display) txt = formatCell(cell, info, wb.date1904);
            else if (info && info.isDate) txt = isoFromSerial(cell.v, wb.date1904);
            else txt = exactNumber(cell.v);
          }
        }
        if (o.protect && isText && /^[=+\-@\t\r]/.test(txt) && !/^-?\d+(\.\d+)?$/.test(txt)) { txt = "'" + txt; prot++; }
        out.push(txt);
      }
      rows.push(out);
    }
    return { rows: rows, skippedRows: skippedRows, skippedCols: skippedCols, protectedCells: prot };
  }

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */
  function parseCsv(text, delim) {
    text = String(text).replace(/^\ufeff/, '');
    var rows = [], row = [], f = '', q = false, bad = false, i = 0, n = text.length, any = false;
    for (; i < n; i++) {
      var ch = text.charAt(i);
      if (q) {
        if (ch === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === '') { q = true; any = true; }
      else if (ch === delim) { row.push(f); f = ''; any = true; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        if (row.length || f !== '' || any) { row.push(f); rows.push(row); }
        row = []; f = ''; any = false;
      } else { f += ch; any = true; }
    }
    if (q) bad = true;
    if (row.length || f !== '' || any) { row.push(f); rows.push(row); }
    return { rows: rows, badQuote: bad };
  }

  function detectDelimiter(text) {
    var sample = String(text).replace(/^\ufeff/, '').slice(0, 20000), cands = [',', ';', '\t', '|'], best = ',', bestScore = 0;
    cands.forEach(function (d) {
      var rs = parseCsv(sample, d).rows.slice(0, 40), counts = {}, mode = 0, modeN = 0;
      rs.forEach(function (r) { counts[r.length] = (counts[r.length] || 0) + 1; });
      Object.keys(counts).forEach(function (k) { if (counts[k] > modeN || (counts[k] === modeN && +k > mode)) { mode = +k; modeN = counts[k]; } });
      var score = mode >= 2 ? modeN * 1000 + mode : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  /** o: {delim, bom, eol} -> text */
  function writeCsv(rows, o) {
    o = o || {};
    var d = o.delim || ',', eol = o.eol || '\r\n';
    var body = rows.map(function (r) {
      return r.map(function (v) {
        v = v == null ? '' : String(v);
        return (v.indexOf(d) >= 0 || /["\r\n]/.test(v) || /^\s|\s$/.test(v)) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(d);
    }).join(eol);
    return (o.bom ? '\ufeff' : '') + body + (rows.length ? eol : '');
  }

  var NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/, NUM_GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  /** Typed value for one CSV field, or the text itself. Leading zeros, plus signs and 16+ digit numbers stay text. */
  function typeValue(s, o) {
    var t = s.trim();
    if (!t) return s === '' ? '' : s;
    if (o.numbers) {
      var isNum = NUM_RE.test(t), grouped = !isNum && NUM_GROUPED.test(t);
      if (isNum || grouped) {
        var digits = t.replace(/[eE].*$/, '').replace(/[^0-9]/g, '').replace(/^0+/, '');
        if (digits.length <= 15) {
          var v = Number(grouped ? t.replace(/,/g, '') : t);
          if (isFinite(v)) return { num: v, kept: false };
        }
        return { text: s, kept: true };
      }
      if (/^-?0\d+$/.test(t)) return { text: s, kept: true };   // leading zeros (account numbers, phone numbers) are data
    }
    if (o.dates) {
      var m = ISO_RE.exec(t);
      if (m) {
        var y = +m[1], mo = +m[2], d = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
        var dt = new Date(Date.UTC(y, mo - 1, d));
        if (y > 1900 || (y === 1900 && mo >= 3)) {
          if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && hh < 24 && mi < 60 && ss < 60) {
            return { date: dateToSerial(y, mo, d, hh, mi, ss), time: !!m[4] };
          }
        }
      }
    }
    return s;
  }

  /** rows of strings -> rows of cells (string | number | {d, time}) plus counts. */
  function csvToCells(rows, o) {
    var st = { numbers: 0, dates: 0, keptText: 0, formulaLike: 0 };
    var out = rows.map(function (r) {
      return r.map(function (s) {
        var v = typeValue(s, o);
        if (v && typeof v === 'object') {
          if (v.num !== undefined) { st.numbers++; return v.num; }
          if (v.date !== undefined) { st.dates++; return { d: v.date, time: v.time }; }
          if (v.kept) { st.keptText++; return v.text; }
        }
        if (typeof v === 'string' && /^[=+\-@]/.test(v) && !NUM_RE.test(v.trim())) st.formulaLike++;
        return v;
      });
    });
    return { rows: out, stats: st };
  }

  /* ------------------------------------------------------------------ */
  /* Writing .xlsx                                                       */
  /* ------------------------------------------------------------------ */
  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function safeSheetName(name, used) {
    var s = String(name || 'Sheet1').replace(/[\\\/?*\[\]:]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet1';
    if (/^history$/i.test(s)) s = 'History_';
    var base = s, n = 2;
    while (used.some(function (u) { return u.toLowerCase() === s.toLowerCase(); })) { var suf = ' (' + n++ + ')'; s = base.slice(0, 31 - suf.length) + suf; }
    return s;
  }

  /** sheets: [{name, rows: cells[][], header: bool}]; cell: string | number | {d, time} | null. o: {scrub, title}  -> {bytes, truncated} */
  function buildXlsx(sheets, o) {
    o = o || {};
    var sstMap = {}, sstList = [], truncated = 0, usedNames = [];
    function sst(s) { if (s.length > XL_MAX_TEXT) { s = s.slice(0, XL_MAX_TEXT); truncated++; } if (sstMap[s] === undefined) { sstMap[s] = sstList.length; sstList.push(s); } return sstMap[s]; }
    var files = [], now = new Date();
    var sheetXml = sheets.map(function (sh) {
      if (sh.rows.length > XL_MAX_ROWS) throw new Error('Excel sheets can hold at most 1,048,576 rows. This data has ' + sh.rows.length.toLocaleString() + '.');
      var nCols = 0; sh.rows.forEach(function (r) { if (r.length > nCols) nCols = r.length; });
      if (nCols > XL_MAX_COLS) throw new Error('Excel sheets can hold at most 16,384 columns. This data has ' + nCols.toLocaleString() + '.');
      var widths = [], i, j;
      for (j = 0; j < nCols; j++) widths[j] = 8;
      var data = sh.rows.map(function (r, ri) {
        var cells = '';
        for (j = 0; j < r.length; j++) {
          var v = r[j];
          if (v === '' || v == null) continue;
          var ref = colName(j) + (ri + 1), style = (sh.header && ri === 0) ? ' s="1"' : '', len;
          if (typeof v === 'number') { cells += '<c r="' + ref + '"' + style + '><v>' + String(v) + '</v></c>'; len = String(v).length; }
          else if (typeof v === 'object') { cells += '<c r="' + ref + '" s="' + (v.time ? 3 : 2) + '"><v>' + String(v.d) + '</v></c>'; len = v.time ? 19 : 10; }
          else { cells += '<c r="' + ref + '"' + style + ' t="s"><v>' + sst(String(v)) + '</v></c>'; len = Math.min(String(v).length, 60); }
          if (ri < 1000 && len + 2 > widths[j]) widths[j] = Math.min(60, len + 2);
        }
        return '<row r="' + (ri + 1) + '">' + cells + '</row>';
      }).join('');
      var cols = '<cols>' + widths.map(function (w, k) { return '<col min="' + (k + 1) + '" max="' + (k + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>';
      var view = '<sheetViews><sheetView workbookViewId="0"' + (usedNames.length === 0 ? ' tabSelected="1"' : '') + '>' +
        (sh.header && sh.rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : '') + '</sheetView></sheetViews>';
      var filter = (sh.header && sh.rows.length > 1 && nCols) ? '<autoFilter ref="A1:' + colName(nCols - 1) + sh.rows.length + '"/>' : '';
      usedNames.push(sh.name);
      return XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '">' + view + '<sheetFormatPr defaultRowHeight="15"/>' + (nCols ? cols : '') + '<sheetData>' + data + '</sheetData>' + filter + '</worksheet>';
    });
    var names = []; sheets.forEach(function (sh) { sh.name = safeSheetName(sh.name, names); names.push(sh.name); });
    var n = sheets.length, hasProps = !o.scrub;

    files.push({ name: '[Content_Types].xml', data: enc.encode(XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      (hasProps ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' : '') + '</Types>') });
    files.push({ name: '_rels/.rels', data: enc.encode(XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      (hasProps ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' : '') + '</Relationships>') });
    if (hasProps) {
      files.push({ name: 'docProps/core.xml', data: enc.encode(XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Quanttum PDF</dc:creator>' + (o.title ? '<dc:title>' + C.xmlEscape(o.title) + '</dc:title>' : '') + '<dcterms:created xsi:type="dcterms:W3CDTF">' + now.toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>') });
      files.push({ name: 'docProps/app.xml', data: enc.encode(XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Quanttum PDF</Application></Properties>') });
    }
    files.push({ name: 'xl/workbook.xml', data: enc.encode(XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '"><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + C.xmlEscape(s.name).replace(/"/g, '&quot;') + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId' + (n + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>') });
    files.push({ name: 'xl/styles.xml', data: enc.encode(XML_HEAD + '<styleSheet xmlns="' + NS_MAIN + '"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') });
    files.push({ name: 'xl/sharedStrings.xml', data: enc.encode(XML_HEAD + '<sst xmlns="' + NS_MAIN + '" count="' + sstList.length + '" uniqueCount="' + sstList.length + '">' +
      sstList.map(function (s) { return '<si><t' + (/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '') + '>' + C.xmlEscape(s) + '</t></si>'; }).join('') + '</sst>') });
    sheetXml.forEach(function (x, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(x) }); });
    return { bytes: C.zipStore(files, now), truncated: truncated, names: names };
  }

  /* ------------------------------------------------------------------ */
  /* Excel -> PDF                                                        */
  /* ------------------------------------------------------------------ */
  /**
   * o: {PDFLib, workbook, sheets:[index], includeHidden, orientation:'auto'|'portrait'|'landscape', pageSize, margin,
   *     fit:'shrink'|'split', fontSize, gridlines, repeatHeader, scrub, title, onProgress}
   * -> {bytes, pages, replaced, info:[{name, rows, cols, pages, bands}], skipped:[name]}
   */
  async function xlsxToPdf(o) {
    var PDFLib = o.PDFLib, wb = o.workbook, out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    C.setMeta(out, o);
    var F = await C.embedFonts(out, PDFLib, 'Helvetica'), safe = C.makeSafe(F.r), rgb = PDFLib.rgb;
    var P = C.PAGE[o.pageSize] || C.PAGE.a4, m = o.margin == null ? 36 : o.margin, fs0 = o.fontSize || 9;
    var gridColor = rgb(0.78, 0.78, 0.78), black = rgb(0, 0, 0), gray = rgb(0.45, 0.45, 0.45);
    var allPages = [], info = [], skipped = [], drawn = 0;
    var idxs = o.sheets && o.sheets.length ? o.sheets : wb.sheets.map(function (s, i) { return i; }).filter(function (i) { return wb.sheets[i].state === 'visible'; });

    function hex(c) { var n = parseInt(c, 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }

    for (var si = 0; si < idxs.length; si++) {
      var sh = wb.sheets[idxs[si]];
      if (o.onProgress) o.onProgress(si / idxs.length, sh.name);
      var rowsIdx = [], colsIdx = [], r, c;
      for (r = 0; r < sh.nRows; r++) if (o.includeHidden || !(sh.rowMeta[r] && sh.rowMeta[r].hidden)) rowsIdx.push(r);
      for (c = 0; c < sh.nCols; c++) if (o.includeHidden || !(sh.colInfo[c] && sh.colInfo[c].hidden)) colsIdx.push(c);
      if (!rowsIdx.length || !colsIdx.length || !sh.nRows) { skipped.push(sh.name); continue; }
      if (rowsIdx.length * colsIdx.length > MAX_PDF_CELLS) throw new Error('The sheet "' + sh.name + '" has ' + (rowsIdx.length * colsIdx.length).toLocaleString() + ' cells, which is too many to draw as a PDF. Export it as CSV instead.');

      // cell texts, styles, merges
      var disp = {}, mergeAt = {}, covered = {}, k;
      sh.merges.forEach(function (mg) {
        mergeAt[mg.r0 + ',' + mg.c0] = mg;
        for (var rr = mg.r0; rr <= mg.r1; rr++) for (var cc = mg.c0; cc <= mg.c1; cc++) if (rr !== mg.r0 || cc !== mg.c0) covered[rr + ',' + cc] = true;
      });
      rowsIdx.forEach(function (rr) {
        var row = sh.rows[rr]; if (!row) return;
        colsIdx.forEach(function (cc) {
          var cell = row[cc]; if (!cell) return;
          var t = formatCell(cell, styleOf(wb, cell), wb.date1904);
          if (t !== '') disp[rr + ',' + cc] = safe.fix(t).replace(/\n/g, ' ');
        });
      });

      // column widths in points
      var widths = colsIdx.map(function (cc) {
        var ci = sh.colInfo[cc];
        if (ci && ci.custom && ci.width != null) return Math.max(6, Math.round(ci.width * 7) * 0.75);
        var w = 28;
        for (var q = 0; q < Math.min(rowsIdx.length, 2000); q++) {
          var key = rowsIdx[q] + ',' + cc, t = disp[key];
          if (t && !covered[key]) { var cell = sh.rows[rowsIdx[q]][cc], bold = styleOf(wb, cell) && styleOf(wb, cell).bold; var tw = (bold ? F.b : F.r).widthOfTextAtSize(t, fs0) + 8; if (tw > w) w = tw; }
        }
        return Math.min(220, w);
      });
      var totalW = widths.reduce(function (a, b) { return a + b; }, 0);
      var landscape = o.orientation === 'landscape' || (o.orientation !== 'portrait' && totalW > P[0] - 2 * m);
      var PW = landscape ? P[1] : P[0], PH = landscape ? P[0] : P[1], contentW = PW - 2 * m;
      var S = (o.fit !== 'split' && totalW > contentW) ? Math.max(0.5, contentW / totalW) : 1;

      // bands of columns that fit across the page
      var bands = [], cur = [], curW = 0;
      widths.forEach(function (w, i) {
        var ww = Math.min(w, contentW / S) * S;
        if (cur.length && curW + ww > contentW + 0.01) { bands.push(cur); cur = []; curW = 0; }
        cur.push(i); curW += ww;
      });
      if (cur.length) bands.push(cur);

      // row heights
      var size0 = fs0 * S, lineH = size0 * 1.2, padV = 2 * S, padH = 3 * S;
      var rowH = rowsIdx.map(function (rr) {
        var h = lineH + 2 * padV, row = sh.rows[rr] || [];
        colsIdx.forEach(function (cc, ci) {
          var cell = row[cc]; if (!cell) return;
          var st = styleOf(wb, cell), fsz = size0 * ((st && st.fontSize) ? st.fontSize / 11 : 1);
          h = Math.max(h, fsz * 1.2 + 2 * padV);
          var t = disp[rr + ',' + cc];
          if (t && st && st.wrap) {
            var lines = C.wrap(t, st.bold ? F.b : F.r, fsz, Math.max(10, Math.min(widths[ci], contentW / S) * S - 2 * padH)).length;
            h = Math.max(h, lines * fsz * 1.2 + 2 * padV);
          }
        });
        var meta = sh.rowMeta[rr];
        if (meta && meta.custom && meta.ht) h = Math.max(h, meta.ht * (fs0 / 11) * S);
        return Math.min(h, PH - 2 * m - 20);
      });

      var firstPage = allPages.length, headerIdx = (o.repeatHeader && rowsIdx.length > 1) ? 0 : -1;
      for (var bi = 0; bi < bands.length; bi++) {
        var band = bands[bi], bw = band.map(function (i) { return Math.min(widths[i], contentW / S) * S; }), bandW = bw.reduce(function (a, b) { return a + b; }, 0);
        var xs = [m]; bw.forEach(function (w) { xs.push(xs[xs.length - 1] + w); });
        var page = null, y = 0, pageRows = [];

        var finishPage = function () {
          if (!page || !pageRows.length) return;
          if (o.gridlines !== false) {
            var yy = PH - m, bottom = y;
            page.drawLine({ start: { x: m, y: yy }, end: { x: m + bandW, y: yy }, thickness: 0.4, color: gridColor });
            pageRows.forEach(function (pr) { yy -= pr.h; page.drawLine({ start: { x: m, y: yy }, end: { x: m + bandW, y: yy }, thickness: 0.4, color: gridColor }); });
            xs.forEach(function (x) { page.drawLine({ start: { x: x, y: PH - m }, end: { x: x, y: bottom } , thickness: 0.4, color: gridColor }); });
          }
        };
        var startPage = function () {
          finishPage();
          page = out.addPage([PW, PH]); allPages.push({ page: page, W: PW });
          y = PH - m; pageRows = [];
          var label = safe.fix(sh.name) + (bands.length > 1 ? '  (columns ' + colName(colsIdx[band[0]]) + ' to ' + colName(colsIdx[band[band.length - 1]]) + ')' : '');
          page.drawText(label, { x: m, y: PH - m + 12, size: 8, font: F.r, color: gray });
        };
        var drawRow = function (ri) {
          var rr = rowsIdx[ri], h = rowH[ri], row = sh.rows[rr] || [];
          pageRows.push({ h: h });
          band.forEach(function (ci, bcol) {
            var cc = colsIdx[ci], key = rr + ',' + cc, cell = row[cc], st = styleOf(wb, cell);
            if (covered[key]) return;
            var x = xs[bcol], w = bw[bcol], mg = mergeAt[key];
            if (mg && mg.r1 === mg.r0) {   // horizontal merge spans the band columns it covers
              var extra = 0; for (var q = bcol + 1; q < band.length && colsIdx[band[q]] <= mg.c1; q++) extra += bw[q];
              w += extra;
            }
            if (st && st.fill) page.drawRectangle({ x: x, y: y - h, width: w, height: h, color: hex(st.fill) });
            var t = disp[key]; if (!t) return;
            var fsz = size0 * ((st && st.fontSize) ? st.fontSize / 11 : 1), font = (st && st.bold) ? F.b : F.r, color = (st && st.color) ? hex(st.color) : black;
            var align = st && st.align, kind = cell.k;
            if (!align || align === 'general') align = (kind === 'n' && !(st && st.isDate && false)) ? 'right' : (kind === 'b' || kind === 'e') ? 'center' : 'left';
            if (st && st.wrap) {
              C.wrap(t, font, fsz, Math.max(10, w - 2 * padH)).forEach(function (ln, li) {
                ln = ln.replace(/\s+$/, ''); if (!ln) return;
                var lw = font.widthOfTextAtSize(ln, fsz), lx = align === 'right' ? x + w - padH - lw : align === 'center' ? x + (w - lw) / 2 : x + padH;
                page.drawText(ln, { x: lx, y: y - padV - fsz * 0.85 - li * fsz * 1.2, size: fsz, font: font, color: color });
              });
              drawn++; return;
            }
            var tw = font.widthOfTextAtSize(t, fsz), avail = w - 2 * padH, clipW = w;
            if (tw > avail && align === 'left' && kind === 's') {   // text spills over empty cells to its right, as in Excel
              for (var q2 = bcol + 1; q2 < band.length && tw > clipW - 2 * padH; q2++) {
                var nk = rr + ',' + colsIdx[band[q2]];
                if (disp[nk] || covered[nk]) break;
                clipW += bw[q2];
              }
            }
            var tx = align === 'right' ? x + w - padH - tw : align === 'center' ? x + (w - tw) / 2 : x + padH;
            if (tw > clipW - 2 * padH) {
              tx = Math.max(x + padH, tx);
              page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.rectangle(x, y - h, clipW, h), PDFLib.clip(), PDFLib.endPath());
              page.drawText(t, { x: tx, y: y - padV - fsz * 0.85, size: fsz, font: font, color: color });
              page.pushOperators(PDFLib.popGraphicsState());
            } else page.drawText(t, { x: tx, y: y - padV - fsz * 0.85, size: fsz, font: font, color: color });
            drawn++;
          });
          y -= h;
        };

        startPage();
        for (var ri = 0; ri < rowsIdx.length; ri++) {
          if (y - rowH[ri] < m - 0.01 && pageRows.length) {
            startPage();
            if (headerIdx >= 0 && ri !== headerIdx) drawRow(headerIdx);
          }
          drawRow(ri);
        }
        finishPage();
      }
      info.push({ name: sh.name, rows: rowsIdx.length, cols: colsIdx.length, pages: allPages.length - firstPage, bands: bands.length, scale: S, landscape: landscape });
    }
    if (!allPages.length) throw new Error('There is nothing to draw: the selected sheets are empty' + (o.includeHidden ? '.' : ' or hidden.'));
    var hv = F.r, total = allPages.length;
    allPages.forEach(function (ap, i) {
      var s = (i + 1) + ' / ' + total, w = hv.widthOfTextAtSize(s, 8);
      ap.page.drawText(s, { x: (ap.W - w) / 2, y: Math.max(10, m / 2 - 4), size: 8, font: hv, color: gray });
    });
    return { bytes: await out.save(), pages: total, replaced: safe.replaced, info: info, skipped: skipped };
  }

  /* ------------------------------------------------------------------ */
  /* PDF text -> table                                                   */
  /* ------------------------------------------------------------------ */
  /** "1,234.50", "(1,200)" and "-7" become numbers; "007", "+233...", and anything over 15 digits stay text. */
  function numberFromText(s) {
    var t = s.trim();
    if (!/^\(?-?(0|[1-9]\d{0,2}(,\d{3})+|[1-9]\d*)(\.\d+)?\)?$/.test(t)) return null;
    var paren = /^\(.*\)$/.test(t), digits = t.replace(/[^0-9]/g, '').replace(/^0+/, '');
    if (digits.length > 15) return null;
    var v = Number(t.replace(/[(),]/g, ''));
    if (!isFinite(v)) return null;
    return paren ? -Math.abs(v) : v;
  }

  /** items: [{str, x, y, w, h}] in view space (y down). -> [{y, h, segs:[{x0,x1,text}]}] top to bottom */
  function rowsFromItems(items) {
    var its = items.filter(function (it) { return it.str && it.str.trim(); }).sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var rows = [];
    its.forEach(function (it) {
      var last = rows[rows.length - 1], h = it.h || 10;
      if (last && Math.abs(it.y - last.y) <= Math.max(2, 0.5 * Math.min(h, last.h))) { last.items.push(it); last.h = Math.max(last.h, h); }
      else rows.push({ y: it.y, h: h, items: [it] });
    });
    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.x - b.x; });
      var segs = [], cur = null;
      row.items.forEach(function (it) {
        var txt = it.str.trim(), x1 = it.x + it.w;
        if (cur && it.x - cur.x1 <= 0.5 * row.h) {
          cur.text += (it.x - cur.x1 > 0.1 * row.h ? ' ' : '') + txt; cur.x1 = Math.max(cur.x1, x1);
        } else { cur = { x0: it.x, x1: x1, text: txt }; segs.push(cur); }
      });
      row.segs = segs; delete row.items;
    });
    return rows;
  }

  /** Column spans from rows that have two or more segments. -> [{x0,x1}] */
  function detectColumns(rows) {
    var tr = rows.filter(function (r) { return r.segs.length >= 2; });
    if (!tr.length) return [];
    var xsSet = {};
    tr.forEach(function (r) { r.segs.forEach(function (s) { xsSet[s.x0.toFixed(1)] = s.x0; xsSet[s.x1.toFixed(1)] = s.x1; }); });
    var xs = Object.keys(xsSet).map(function (k) { return xsSet[k]; }).sort(function (a, b) { return a - b; });
    var tol = Math.floor(0.1 * tr.length), cols = [], cur = null;
    for (var i = 0; i < xs.length - 1; i++) {
      var a = xs[i], b = xs[i + 1], cover = 0;
      for (var j = 0; j < tr.length; j++) {
        var segs = tr[j].segs;
        for (var k = 0; k < segs.length; k++) if (segs[k].x0 <= a + 0.01 && segs[k].x1 >= b - 0.01) { cover++; break; }
      }
      var gap = cover <= tol && (b - a) >= 3;
      if (gap) { if (cur) { cols.push(cur); cur = null; } }
      else if (cur) cur.x1 = b; else cur = { x0: a, x1: b };
    }
    if (cur) cols.push(cur);
    return cols;
  }

  function assignRows(rows, cols, numbers) {
    var out = [], textRows = 0;
    rows.forEach(function (row) {
      var cells = cols.map(function () { return ''; });
      if (!cols.length) { cells = [row.segs.map(function (s) { return s.text; }).join(' ')]; }
      else if (row.segs.length === 1) { cells[0] = row.segs[0].text; textRows++; }
      else {
        row.segs.forEach(function (s) {
          var best = 0, bo = -1;
          cols.forEach(function (c, i) { var ov = Math.min(s.x1, c.x1) - Math.max(s.x0, c.x0); if (ov > bo) { bo = ov; best = i; } });
          cells[best] = cells[best] ? cells[best] + ' ' + s.text : s.text;
        });
      }
      out.push(cells);
    });
    if (numbers) out = out.map(function (r) { return r.map(function (v) { var n = numberFromText(v); return n === null ? v : n; }); });
    return { rows: out, textRows: textRows };
  }

  /** pages: [{num, items}]; o: {perPage, numbers} -> {sheets:[{name, rows}], stats:{tableRows, columns, textRows}} */
  function tableFromPages(pages, o) {
    o = o || {};
    var parsed = pages.map(function (p) { return { num: p.num, rows: rowsFromItems(p.items) }; });
    var sheets = [], tableRows = 0, columns = 0, textRows = 0, repeated = 0;
    function build(name, rowSets) {
      var all = [];
      rowSets.forEach(function (rs, pi) { rs.forEach(function (r) { r.page = pi; all.push(r); }); });
      if (!all.length) return;
      var cols = detectColumns(all), res = assignRows(all, cols, o.numbers !== false), rows = res.rows;
      // a table that continues on the next page usually repeats its header row: keep it once
      var hi = -1; all.forEach(function (r, i) { if (hi < 0 && r.segs.length >= 2) hi = i; });
      if (hi >= 0 && rowSets.length > 1) {
        var key = JSON.stringify(rows[hi]), keep = [];
        rows.forEach(function (r, i) { if (i > hi && all[i].page > all[hi].page && all[i].segs.length >= 2 && JSON.stringify(r) === key) repeated++; else keep.push(r); });
        rows = keep;
      }
      tableRows += all.filter(function (r) { return r.segs.length >= 2; }).length; columns = Math.max(columns, cols.length || 1); textRows += res.textRows;
      sheets.push({ name: name, rows: rows });
    }
    if (o.perPage) parsed.forEach(function (p) { build('Page ' + p.num, [p.rows]); });
    else build('PDF', parsed.map(function (p) { return p.rows; }));
    return { sheets: sheets, stats: { tableRows: tableRows - repeated, columns: columns, textRows: textRows, repeatedHeaders: repeated } };
  }

  return {
    colName: colName, colIndex: colIndex, parseRef: parseRef,
    serialToParts: serialToParts, isoFromSerial: isoFromSerial, dateToSerial: dateToSerial,
    isDateCode: isDateCode, formatNumber: formatNumber, formatDate: formatDate, formatCell: formatCell, exactNumber: exactNumber,
    readXlsx: readXlsx, workbookFindings: workbookFindings, sheetToRows: sheetToRows,
    parseCsv: parseCsv, detectDelimiter: detectDelimiter, writeCsv: writeCsv, typeValue: typeValue, csvToCells: csvToCells,
    buildXlsx: buildXlsx, safeSheetName: safeSheetName, xlsxToPdf: xlsxToPdf,
    rowsFromItems: rowsFromItems, detectColumns: detectColumns, tableFromPages: tableFromPages, numberFromText: numberFromText
  };
});
