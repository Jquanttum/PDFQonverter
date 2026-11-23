/* Quanttum PDF - office.js
 * Looks inside Word (.docx), Excel (.xlsx / .xlsm) and PowerPoint (.pptx) files for what the program that opened them
 * would not show: who touched the file, tracked changes and the text they deleted, hidden text, hidden sheets and slides,
 * speaker notes, leftover strings, template paths from someone's computer, macros, and oddities in the zip container.
 * No DOM and no network, so it runs in Node for tests.   QOffice.inspect(QConvert, bytes, { now }) -> result
 * Findings are prompts for a closer look, not verdicts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QOffice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var dec = new TextDecoder('utf-8');
  var DAY = 86400000;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
  function clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function utc(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC'; }
  function dayStr(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function unique(a) { var o = [], s = {}; a.forEach(function (x) { if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }

  /* ---------------------------------------------------------------- XML helpers (regex based, on purpose: no DOM) */
  function xdec(C, s) { return C.xmlDecode(s == null ? '' : s); }
  function attr(tagText, name) {
    var m = new RegExp('(?:^|[\\s])' + name.replace(/[:.]/g, '\\$&') + '\\s*=\\s*"([^"]*)"').exec(tagText);
    return m ? m[1] : null;
  }
  function textOf(C, xml, tag) {
    var m = new RegExp('<' + tag.replace(/[:.]/g, '\\$&') + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag.replace(/[:.]/g, '\\$&') + '>').exec(xml);
    return m ? xdec(C, m[1].replace(/<[^>]+>/g, '')).trim() : '';
  }
  function parseDate(s) {
    if (!s) return null;
    var t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z');
    return isNaN(t) ? null : new Date(t);
  }

  /* ---------------------------------------------------------------- the zip container, read directly */
  function dosDate(date, time) {
    if (!date) return null;
    var y = 1980 + (date >> 9), mo = (date >> 5) & 15, d = date & 31, h = time >> 11, mi = (time >> 5) & 63, s = (time & 31) * 2;
    if (!mo || !d) return null;
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  }
  function readDirectory(bytes) {
    var n = bytes.length, i = n - 22, min = Math.max(0, n - 65557);
    while (i >= min && u32(bytes, i) !== 0x06054b50) i--;
    if (i < min) return null;
    var count = u16(bytes, i + 10), p = u32(bytes, i + 16), entries = [];
    var eocdEnd = i + 22 + u16(bytes, i + 20);
    for (var k = 0; k < count; k++) {
      if (p + 46 > n || u32(bytes, p) !== 0x02014b50) break;
      var nl = u16(bytes, p + 28), el = u16(bytes, p + 30), cl = u16(bytes, p + 32);
      entries.push({
        name: dec.decode(bytes.subarray(p + 46, p + 46 + nl)), host: bytes[p + 5], method: u16(bytes, p + 10),
        csize: u32(bytes, p + 20), usize: u32(bytes, p + 24), when: dosDate(u16(bytes, p + 14), u16(bytes, p + 12)), lo: u32(bytes, p + 42)
      });
      p += 46 + nl + el + cl;
    }
    return { entries: entries, declared: count, eocdEnd: eocdEnd, trailing: n - eocdEnd };
  }

  /* ---------------------------------------------------------------- relationships: what is reachable, what is external */
  function dirOf(part) { var i = part.lastIndexOf('/'); return i < 0 ? '' : part.slice(0, i + 1); }
  function resolve(base, target) {
    var path = target.charAt(0) === '/' ? target.slice(1) : dirOf(base) + target, out = [];
    path.split('/').forEach(function (s) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); });
    return out.join('/');
  }
  function relsOwner(relsName) {
    // "word/_rels/document.xml.rels" belongs to "word/document.xml"; "_rels/.rels" belongs to the package itself
    if (relsName === '_rels/.rels') return '';
    var m = /^(.*?)_rels\/([^/]+)\.rels$/.exec(relsName);
    return m ? m[1] + m[2] : null;
  }

  /* ---------------------------------------------------------------- main */
  async function inspect(C, bytes, opts) {
    opts = opts || {};
    var now = opts.now || new Date(), findings = [], sections = [];
    function warn(t) { findings.push({ level: 'warn', text: t }); }
    function info(t) { findings.push({ level: 'info', text: t }); }

    var head = bytes.subarray(0, 8);
    if (head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0) {
      throw new Error('This is an older Office file (.doc, .xls or .ppt) or a password-protected one. Only the modern .docx, .xlsx and .pptx formats can be inspected.');
    }
    var dir = readDirectory(bytes);
    if (!dir) throw new Error('This is not an Office Open XML file (.docx, .xlsx or .pptx). It is not a zip container.');
    var zip;
    try { zip = C.zipRead(bytes); } catch (e) { throw new Error('The zip container is damaged: ' + e.message); }
    var names = dir.entries.map(function (e) { return e.name; });
    var byName = {}; dir.entries.forEach(function (e) { byName[e.name] = e; });
    async function read(name) { try { return zip.has(name) ? dec.decode(await zip.get(name)) : null; } catch (e) { return null; } }
    if (!zip.has('[Content_Types].xml')) throw new Error('This zip file is not an Office document: it has no [Content_Types].xml.');

    /* what kind of document */
    var rootRels = (await read('_rels/.rels')) || '', kind = 'unknown';
    var main = (/Type="[^"]*\/officeDocument"[^>]*Target="([^"]+)"/.exec(rootRels) || /Target="([^"]+)"[^>]*Type="[^"]*\/officeDocument"/.exec(rootRels) || [])[1] || '';
    main = main ? resolve('', main) : '';
    if (/^word\//.test(main)) kind = 'docx'; else if (/^xl\//.test(main)) kind = 'xlsx'; else if (/^ppt\//.test(main)) kind = 'pptx';
    if (kind === 'unknown') {
      if (zip.has('word/document.xml')) kind = 'docx'; else if (zip.has('xl/workbook.xml')) kind = 'xlsx'; else if (zip.has('ppt/presentation.xml')) kind = 'pptx';
    }
    if (kind === 'unknown') throw new Error('This zip file does not look like a Word, Excel or PowerPoint document.');
    var kindName = { docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation' }[kind];

    /* ---------- document properties ---------- */
    var coreXml = (await read('docProps/core.xml')) || '', appXml = (await read('docProps/app.xml')) || '', customXml = (await read('docProps/custom.xml')) || '';
    var core = {
      title: textOf(C, coreXml, 'dc:title'), subject: textOf(C, coreXml, 'dc:subject'), creator: textOf(C, coreXml, 'dc:creator'),
      keywords: textOf(C, coreXml, 'cp:keywords'), description: textOf(C, coreXml, 'dc:description'), lastModifiedBy: textOf(C, coreXml, 'cp:lastModifiedBy'),
      revision: textOf(C, coreXml, 'cp:revision'), created: textOf(C, coreXml, 'dcterms:created'), modified: textOf(C, coreXml, 'dcterms:modified'),
      lastPrinted: textOf(C, coreXml, 'cp:lastPrinted'), category: textOf(C, coreXml, 'cp:category'), contentStatus: textOf(C, coreXml, 'cp:contentStatus')
    };
    var app = {
      application: textOf(C, appXml, 'Application'), appVersion: textOf(C, appXml, 'AppVersion'), company: textOf(C, appXml, 'Company'), manager: textOf(C, appXml, 'Manager'),
      template: textOf(C, appXml, 'Template'), totalTime: textOf(C, appXml, 'TotalTime'), pages: textOf(C, appXml, 'Pages'), words: textOf(C, appXml, 'Words'),
      slides: textOf(C, appXml, 'Slides'), hiddenSlides: textOf(C, appXml, 'HiddenSlides'), notes: textOf(C, appXml, 'Notes'), docSecurity: textOf(C, appXml, 'DocSecurity'),
      hyperlinkBase: textOf(C, appXml, 'HyperlinkBase')
    };
    var custom = [], cm, cre = /<property\b([^>]*)>([\s\S]*?)<\/property>/g;
    while ((cm = cre.exec(customXml))) custom.push({ name: xdec(C, attr(cm[1], 'name') || ''), value: xdec(C, cm[2].replace(/<[^>]+>/g, '')).trim() });

    var created = parseDate(core.created), modified = parseDate(core.modified), printed = parseDate(core.lastPrinted);
    var propRows = [['Title', core.title], ['Subject', core.subject], ['Author (creator)', core.creator], ['Last saved by', core.lastModifiedBy],
      ['Created', created ? utc(created) : core.created], ['Modified', modified ? utc(modified) : core.modified], ['Last printed', printed ? utc(printed) : core.lastPrinted],
      ['Revision number', core.revision], ['Total editing time', app.totalTime ? app.totalTime + ' min' : ''], ['Written by', [app.application, app.appVersion].filter(Boolean).join(' ')],
      ['Company', app.company], ['Manager', app.manager], ['Template', app.template], ['Keywords', core.keywords], ['Comments field', core.description], ['Category', core.category], ['Status', core.contentStatus],
      ['Pages', app.pages], ['Words', app.words], ['Slides', app.slides], ['Hidden slides (as claimed)', app.hiddenSlides]].filter(function (r) { return r[1]; });
    sections.push({ title: 'Document properties', kind: 'kv', rows: propRows, empty: 'The file carries no document properties.' });
    if (custom.length) sections.push({ title: 'Custom properties', kind: 'table', head: ['Name', 'Value'], rows: custom.map(function (c) { return [c.name, c.value]; }) });

    /* ---------- consistency of what the file says about itself ---------- */
    if (core.created && !created) warn('The created date “' + clip(core.created, 40) + '” is not a valid date.');
    if (core.modified && !modified) warn('The modified date “' + clip(core.modified, 40) + '” is not a valid date.');
    if (created && modified && modified < created) warn('The file says it was modified (' + utc(modified) + ') before it was created (' + utc(created) + '). That cannot happen in normal use. It can follow from copying a template, from a wrong clock, or from edited properties.');
    [['created', created], ['modified', modified], ['last printed', printed]].forEach(function (p) {
      if (p[1] && p[1].getTime() > now.getTime() + DAY) warn('The ' + p[0] + ' date (' + utc(p[1]) + ') is in the future.');
    });
    if (core.creator && core.lastModifiedBy && core.creator !== core.lastModifiedBy) info('Written by “' + core.creator + '” and last saved by “' + core.lastModifiedBy + '”, so at least two people (or two user names) handled the file.');
    if (app.docSecurity && app.docSecurity !== '0') info('The file asks to be opened ' + ({ '1': 'password protected', '2': 'read-only recommended', '4': 'read-only enforced', '8': 'locked for annotation' }[app.docSecurity] || 'with a security setting') + ' (DocSecurity ' + app.docSecurity + ').');
    var labels = custom.filter(function (c) { return /^MSIP_Label|^Sensitivity|^Classification/i.test(c.name); });
    if (labels.length) info('A sensitivity or classification label is stored in the file: ' + labels.map(function (l) { return l.name + ' = ' + (l.value || '?'); }).join('; ') + '.');
    else if (custom.length) info(plural(custom.length, 'custom property is', 'custom properties are') + ' stored in the file. Programs and organisations use these for document IDs, client codes and labels.');
    if (/^microsoft/i.test(app.application) && names[0] !== '[Content_Types].xml') {
      info('The file says Microsoft ' + (kind === 'docx' ? 'Word' : kind === 'xlsx' ? 'Excel' : 'PowerPoint') + ' wrote it, but the first part in the zip is “' + names[0] + '”, not [Content_Types].xml, which Microsoft Office writes first. That fits a file that was rewritten by other software afterwards. Many harmless tools do this.');
    }

    /* ---------- the container ---------- */
    var whens = dir.entries.map(function (e) { return e.when; }).filter(Boolean).sort(function (a, b) { return a - b; });
    var allDefault = whens.length > 0 && whens.every(function (d) { return d.getUTCFullYear() === 1980 && d.getUTCMonth() === 0 && d.getUTCDate() === 1; });
    var hosts = unique(dir.entries.map(function (e) { return { 0: 'DOS / Windows (FAT)', 3: 'Unix / Linux', 10: 'Windows (NTFS)', 19: 'macOS' }[e.host] || ('system ' + e.host); }));
    var pkgRows = [['Parts in the file', String(names.length)], ['Zip written on', hosts.join(', ')]];
    if (whens.length) pkgRows.push(['Part dates', allDefault ? 'all 1980-01-01 (reset by the program that wrote the file)' : dayStr(whens[0]) + (dayStr(whens[0]) === dayStr(whens[whens.length - 1]) ? '' : ' to ' + dayStr(whens[whens.length - 1])) + ' (stored without a time zone)']);
    if (whens.length && !allDefault) {
      var last = whens[whens.length - 1], first = whens[0];
      if (modified && last.getTime() > modified.getTime() + DAY * 1.5) warn('The parts inside the file are dated ' + dayStr(last) + ', but the file says it was last modified ' + dayStr(modified) + '. Something wrote to the file after the date it claims. That is typical of a file re-saved by another tool or of edited properties.');
      else if (created && first.getTime() < created.getTime() - DAY * 1.5) info('Some parts are dated ' + dayStr(first) + ', earlier than the created date (' + dayStr(created) + '). That is normal when a document is made from an older template.');
    }
    if (allDefault) info('Every part is dated 1980-01-01. Some programs do this to make files reproducible, and it also removes the timestamps a reviewer could use.');

    var dupes = [], seen = {};
    names.forEach(function (n) { if (seen[n]) dupes.push(n); seen[n] = 1; });
    if (dupes.length) warn('The zip directory lists ' + unique(dupes).map(function (d) { return '“' + d + '”'; }).join(', ') + ' more than once. Different programs read different copies, so what you see can depend on the software. Ordinary Office files never do this.');
    if (dir.entries.length !== dir.declared) warn('The zip directory declares ' + dir.declared + ' parts but only ' + dir.entries.length + ' could be read. The directory may be damaged.');
    var trailing = null;
    if (dir.trailing > 0) {
      trailing = { offset: dir.eocdEnd, bytes: dir.trailing };
      warn(plural(dir.trailing, 'byte', 'bytes') + ' follow the end of the zip container. Office ignores them, which makes the area a place where content can be hidden.');
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 3 && bytes[3] === 4)) warn('The file does not begin with a zip header, so something is in front of the container.');

    /* orphan parts: in the zip, but nothing refers to them */
    var relNames = names.filter(function (n) { return /\.rels$/.test(n); }), relsText = {};
    for (var rI = 0; rI < relNames.length; rI++) relsText[relNames[rI]] = (await read(relNames[rI])) || '';
    var reach = {}, queue = [''], externals = [];
    reach[''] = 1;
    while (queue.length) {
      var owner = queue.shift(), rn = owner === '' ? '_rels/.rels' : dirOf(owner) + '_rels/' + owner.slice(dirOf(owner).length) + '.rels';
      if (!relsText.hasOwnProperty(rn)) continue;
      reach[rn] = 1;
      var rx = /<Relationship\b([^>]*)\/?>/g, rm;
      while ((rm = rx.exec(relsText[rn]))) {
        var target = xdec(C, attr(rm[1], 'Target') || ''), type = (attr(rm[1], 'Type') || '').replace(/^.*\//, ''), mode = attr(rm[1], 'TargetMode');
        if (mode === 'External') { externals.push({ part: owner || 'package', type: type, target: target }); continue; }
        var tp = resolve(owner, target);
        if (!reach[tp]) { reach[tp] = 1; queue.push(tp); }
      }
    }
    var orphans = names.filter(function (n) { return !reach[n] && n !== '[Content_Types].xml' && !/\.rels$/.test(n) && !/\/$/.test(n); });
    if (orphans.length) warn(plural(orphans.length, 'part is', 'parts are') + ' in the file but nothing points to ' + (orphans.length === 1 ? 'it' : 'them') + ': ' + orphans.slice(0, 6).map(function (o) { return '“' + o + '”'; }).join(', ') + (orphans.length > 6 ? ' and ' + (orphans.length - 6) + ' more' : '') + '. Office does not show these. They may be leftovers or deliberately hidden.');
    if (orphans.length) pkgRows.push(['Unreferenced parts', orphans.join(', ')]);
    if (trailing) pkgRows.push(['Data after the zip', plural(trailing.bytes, 'byte', 'bytes') + ' at offset ' + trailing.offset]);
    sections.push({ title: 'File container', kind: 'kv', rows: pkgRows });

    /* macros and embedded objects */
    var macro = names.filter(function (n) { return /vbaProject\.bin$/i.test(n); });
    if (macro.length) warn('The file contains a macro project (' + macro[0] + '). Macros are program code that can run when the file is opened. Quanttum PDF never runs them.');
    if (/\.(docm|xlsm|pptm)$/i.test(opts.name || '') && !macro.length) info('The file name says it can hold macros, but no macro project was found in it.');
    var embeds = names.filter(function (n) { return /\/(embeddings|activeX)\//i.test(n) || /oleObject\d*\.bin$/i.test(n); });
    if (embeds.length) info(plural(embeds.length, 'embedded object', 'embedded objects') + ' inside the file (' + embeds.slice(0, 4).join(', ') + (embeds.length > 4 ? ', …' : '') + '). Each one is a complete file of its own and can carry its own metadata.');
    var thumb = names.filter(function (n) { return /(^|\/)thumbnail\.(jpe?g|png|wmf|emf)$/i.test(n); });
    if (thumb.length) info('The file stores a preview picture (' + thumb[0] + ') made when it was last saved by the program that wrote it. It can show what the first page or slide looked like at that moment, even if the content was changed afterwards.');

    /* links and paths */
    var userPath = /[A-Za-z]:\\Users\\[^\\"<>]+|\/Users\/[^/"<>]+|\/home\/[^/"<>]+/;
    var linkRows = externals.map(function (x) { return [x.type, clip(x.target, 140), x.part]; });
    var pathHits = [];
    externals.forEach(function (x) { var pm = userPath.exec(x.target); if (pm) pathHits.push(pm[0]); });
    [coreXml, appXml, customXml].forEach(function (t) { var pm = userPath.exec(xdec(C, t)); if (pm) pathHits.push(pm[0]); });
    pathHits = unique(pathHits);
    if (pathHits.length) warn('The file contains a path from someone’s computer (' + pathHits.slice(0, 3).join(', ') + '). It shows a user account name and folder layout.');
    var tmpl = externals.filter(function (x) { return /attachedTemplate/i.test(x.type); });
    if (tmpl.length) warn('The document is attached to a template outside the file: ' + clip(tmpl[0].target, 120) + '.');
    var linked = externals.filter(function (x) { return /^(oleObject|image|video|audio|package|externalLink|subDocument|frame|hyperlink)$/i.test(x.type) === false && !/attachedTemplate/i.test(x.type); });
    var oleLinks = externals.filter(function (x) { return /^(oleObject|image|externalLink|subDocument|package|video|audio)$/i.test(x.type); });
    if (oleLinks.length) warn(plural(oleLinks.length, 'item is', 'items are') + ' linked from outside the file (' + oleLinks.slice(0, 3).map(function (x) { return x.type + ' → ' + clip(x.target, 60); }).join('; ') + '). Opening the file may try to reach those locations.');
    var hyper = externals.filter(function (x) { return /^hyperlink$/i.test(x.type); });
    if (hyper.length) info(plural(hyper.length, 'web or file link', 'web or file links') + ' in the document.');
    void linked;
    if (linkRows.length) sections.push({ title: 'External references', kind: 'table', head: ['Kind', 'Points to', 'Used by'], rows: linkRows });

    /* ---------- format specific ---------- */
    var report = { kind: kind };
    if (kind === 'docx') await inspectDocx(C, names, read, zip, findings, sections, report);
    else if (kind === 'xlsx') await inspectXlsx(C, names, read, findings, sections, report);
    else await inspectPptx(C, names, read, findings, sections, report);

    // order findings: checks first
    findings.sort(function (a, b) { return (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1); });
    return {
      kind: kind, kindName: kindName, size: bytes.length, parts: names.length, core: core, app: app, custom: custom, created: created, modified: modified,
      zip: { whenFirst: whens[0] || null, whenLast: whens[whens.length - 1] || null, allDefault: allDefault, hosts: hosts, duplicates: unique(dupes), trailing: trailing },
      orphans: orphans, externals: externals, macros: macro, details: report, findings: findings, sections: sections
    };
  }

  /* ---------------------------------------------------------------- Word */
  function changeStats(C, xml, re, dates) {
    var m, who = [], when = [], n = 0;
    while ((m = re.exec(xml))) {
      n++; who.push(xdec(C, attr(m[1], 'w:author') || '(no name)'));
      var d = parseDate(attr(m[1], 'w:date')); if (d) when.push(d);
    }
    when.sort(function (a, b) { return a - b; });
    if (dates) dates.push.apply(dates, when);
    return { count: n, authors: unique(who), first: when[0] || null, last: when[when.length - 1] || null };
  }

  async function inspectDocx(C, names, read, zip, findings, sections, out) {
    function warn(t) { findings.push({ level: 'warn', text: t }); }
    function info(t) { findings.push({ level: 'info', text: t }); }
    var bodyParts = names.filter(function (n) { return /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n); }), xml = '', i;
    for (i = 0; i < bodyParts.length; i++) xml += (await read(bodyParts[i])) || '';
    var all = [], ins = changeStats(C, xml, /<w:ins(?=[\s>\/])([^>]*)>/g, all), del = changeStats(C, xml, /<w:del(?=[\s>\/])([^>]*)>/g, all);
    var mv = changeStats(C, xml, /<w:move(?:From|To)(?=[\s>\/])([^>]*)>/g, all);
    var fmt = changeStats(C, xml, /<w:(?:rPrChange|pPrChange|sectPrChange|tblPrChange|tblGridChange|numberingChange)(?=[\s>\/])([^>]*)>/g, all);
    var total = ins.count + del.count + mv.count + fmt.count;
    var rowsT = [];
    function addRow(label, s) { if (s.count) rowsT.push([label, String(s.count), s.authors.join(', '), s.first ? utc(s.first) : '', s.last ? utc(s.last) : '']); }
    addRow('Insertions', ins); addRow('Deletions', del); addRow('Moves', mv); addRow('Formatting changes', fmt);
    var delTexts = [], dm, dre = /<w:delText(?:\s[^>]*)?>([^<]*)<\/w:delText>/g;
    while ((dm = dre.exec(xml))) { var t = xdec(C, dm[1]).trim(); if (t) delTexts.push(t); }
    var insTexts = [], im, ire = /<w:ins(?=[\s>\/])[^>]*>([\s\S]*?)<\/w:ins>/g;
    while ((im = ire.exec(xml))) { var tt = (im[1].match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(function (x) { return xdec(C, x.replace(/<[^>]+>/g, '')); }).join(''); if (tt.trim()) insTexts.push(tt.trim()); }
    out.tracked = { insertions: ins, deletions: del, moves: mv, formatting: fmt, deletedText: delTexts, insertedText: insTexts };
    if (total) {
      var people = unique([].concat(ins.authors, del.authors, mv.authors, fmt.authors));
      var span = all.length ? ' between ' + dayStr(all.sort(function (a, b) { return a - b; })[0]) + ' and ' + dayStr(all[all.length - 1]) : '';
      warn('The document holds ' + plural(total, 'tracked change', 'tracked changes') + ' by ' + people.map(function (p) { return '“' + p + '”'; }).join(', ') + span + '. Deleted text is still stored in the file' + (delTexts.length ? ': “' + clip(delTexts.join(' … '), 120) + '”' : '') + '.');
      sections.push({ title: 'Tracked changes', kind: 'table', head: ['Kind', 'Count', 'By', 'First', 'Last'], rows: rowsT });
      if (delTexts.length) sections.push({ title: 'Deleted text still in the file', kind: 'list', rows: delTexts.slice(0, 40).map(function (x) { return clip(x, 300); }) });
    }

    // hidden text
    var hidden = [], rm, rre = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    while ((rm = rre.exec(xml))) {
      var vm = /<w:vanish(?![A-Za-z])((?:\s[^>]*)?)\/?>/.exec(rm[1]);
      if (!vm || /w:val="(?:0|false|off)"/.test(vm[1])) continue;
      var rt = (rm[1].match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(function (x) { return xdec(C, x.replace(/<[^>]+>/g, '')); }).join('').trim();
      if (rt) hidden.push(rt);
    }
    out.hiddenText = hidden;
    if (hidden.length) {
      warn(plural(hidden.length, 'piece', 'pieces') + ' of hidden text (formatted as “Hidden”, so it does not show on screen or in print): “' + clip(hidden.join(' … '), 120) + '”.');
      sections.push({ title: 'Hidden text', kind: 'list', rows: hidden.slice(0, 40).map(function (x) { return clip(x, 300); }) });
    }

    // comments
    var cxml = (await read('word/comments.xml')) || '', comments = [], cm, cre = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
    while ((cm = cre.exec(cxml))) {
      var cd = parseDate(attr(cm[1], 'w:date'));
      comments.push({ author: xdec(C, attr(cm[1], 'w:author') || '(no name)'), date: cd, text: xdec(C, (cm[2].match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(function (x) { return x.replace(/<[^>]+>/g, ''); }).join(' ')) });
    }
    out.comments = comments;
    if (comments.length) {
      info(plural(comments.length, 'comment', 'comments') + ' by ' + unique(comments.map(function (c) { return '“' + c.author + '”'; })).join(', ') + '. Comments can include remarks the author did not expect others to read.');
      sections.push({ title: 'Comments', kind: 'table', head: ['By', 'Date', 'Comment'], rows: comments.map(function (c) { return [c.author, c.date ? utc(c.date) : '', clip(c.text, 300)]; }) });
    }

    // editing sessions and people
    var settings = (await read('word/settings.xml')) || '', rs = {}, rsm, rsre = /<w:rsid(?:Root)?\s+w:val="([0-9A-Fa-f]+)"/g;
    while ((rsm = rsre.exec(settings))) rs[rsm[1].toUpperCase()] = 1;
    var nRsid = Object.keys(rs).length;
    out.rsids = nRsid;
    if (nRsid > 1) info('Word recorded ' + plural(nRsid, 'editing session identifier', 'editing session identifiers') + ' (rsids) in the settings. Each one marks a separate stretch of editing, so this is a rough count of how many times the document was opened and changed. It is not a count of people.');
    var people = (await read('word/people.xml')) || '', pe = [], pm, pre = /w15:author="([^"]*)"/g;
    while ((pm = pre.exec(people))) pe.push(xdec(C, pm[1]));
    out.people = unique(pe);
    if (out.people.length) info('The file lists these people as having worked on it: ' + out.people.map(function (p) { return '“' + p + '”'; }).join(', ') + '.');
    var media = names.filter(function (n) { return /^word\/media\//.test(n); });
    if (media.length) info(plural(media.length, 'picture', 'pictures') + ' in the document. Pictures can carry their own metadata, including camera details and GPS location.');
  }

  /* ---------------------------------------------------------------- Excel */
  async function inspectXlsx(C, names, read, findings, sections, out) {
    function warn(t) { findings.push({ level: 'warn', text: t }); }
    function info(t) { findings.push({ level: 'info', text: t }); }
    var wbXml = (await read('xl/workbook.xml')) || '', relXml = (await read('xl/_rels/workbook.xml.rels')) || '';
    var relMap = {}, rm, rre = /<Relationship\b([^>]*)\/?>/g;
    while ((rm = rre.exec(relXml))) relMap[attr(rm[1], 'Id')] = xdec(C, attr(rm[1], 'Target') || '');
    var sheets = [], sm, sre = /<sheet\b([^>]*)\/?>/g;
    while ((sm = sre.exec(wbXml))) {
      var rid = attr(sm[1], 'r:id'), tgt = relMap[rid] ? resolve('xl/workbook.xml', relMap[rid]) : '';
      sheets.push({ name: xdec(C, attr(sm[1], 'name') || ''), state: attr(sm[1], 'state') || 'visible', part: tgt, hiddenRows: 0, hiddenCols: 0, comments: 0, protectedSheet: false, authors: [] });
    }
    var used = {}, sharedTotal = 0, i;
    for (i = 0; i < sheets.length; i++) {
      var sh = sheets[i], x = sh.part ? (await read(sh.part)) : null;
      if (x == null) continue;
      var rowRe = /<row\b([^>]*)>/g, r;
      while ((r = rowRe.exec(x))) if (/\shidden="(?:1|true)"/.test(' ' + r[1])) sh.hiddenRows++;
      var colRe = /<col\b([^>]*)\/?>/g, c;
      while ((c = colRe.exec(x))) if (/\shidden="(?:1|true)"/.test(' ' + c[1])) { var lo = +attr(c[1], 'min') || 1, hi = +attr(c[1], 'max') || lo; sh.hiddenCols += Math.min(hi, 16384) - lo + 1; }
      sh.protectedSheet = /<sheetProtection\b/.test(x);
      var cellRe = /<c\b([^>]*)>\s*(?:<f[^>]*>[\s\S]*?<\/f>|<f[^>]*\/>)?\s*<v>(\d+)<\/v>/g, cc;
      while ((cc = cellRe.exec(x))) if (/\st="s"/.test(' ' + cc[1])) used[cc[2]] = 1;
    }
    // comments belong to sheets through their own relationships; count them per sheet when possible
    for (i = 0; i < sheets.length; i++) {
      var rp = sheets[i].part ? dirOf(sheets[i].part) + '_rels/' + sheets[i].part.slice(dirOf(sheets[i].part).length) + '.rels' : '', rx = rp ? await read(rp) : null;
      if (!rx) continue;
      var m2, r2 = /<Relationship\b([^>]*)\/?>/g;
      while ((m2 = r2.exec(rx))) {
        if (!/\/comments$/.test(attr(m2[1], 'Type') || '')) continue;
        var cx = await read(resolve(sheets[i].part, xdec(C, attr(m2[1], 'Target') || '')));
        if (!cx) continue;
        sheets[i].comments += (cx.match(/<comment\b/g) || []).length;
        var am, are = /<author>([^<]*)<\/author>/g;
        while ((am = are.exec(cx))) sheets[i].authors.push(xdec(C, am[1]));
      }
    }
    out.sheets = sheets;
    var hiddenSheets = sheets.filter(function (s) { return s.state !== 'visible'; }), veryHidden = sheets.filter(function (s) { return s.state === 'veryHidden'; });
    if (hiddenSheets.length) warn(plural(hiddenSheets.length, 'sheet is', 'sheets are') + ' hidden: ' + hiddenSheets.map(function (s) { return '“' + s.name + '”' + (s.state === 'veryHidden' ? ' (very hidden)' : ''); }).join(', ') + '.' +
      (veryHidden.length ? ' A “very hidden” sheet cannot be unhidden from Excel’s normal menu.' : ''));
    var hr = sheets.reduce(function (a, s) { return a + s.hiddenRows; }, 0), hc = sheets.reduce(function (a, s) { return a + s.hiddenCols; }, 0);
    if (hr || hc) warn([hr ? plural(hr, 'hidden row', 'hidden rows') : '', hc ? plural(hc, 'hidden column', 'hidden columns') : ''].filter(Boolean).join(' and ') + ' in the workbook.');
    var nComments = sheets.reduce(function (a, s) { return a + s.comments; }, 0);
    if (nComments) {
      var authors = unique([].concat.apply([], sheets.map(function (s) { return s.authors; })));
      info(plural(nComments, 'cell comment or note', 'cell comments or notes') + (authors.length ? ' by ' + authors.map(function (a) { return '“' + a + '”'; }).join(', ') : '') + '.');
    }
    sections.push({ title: 'Sheets', kind: 'table', head: ['Sheet', 'State', 'Hidden rows', 'Hidden columns', 'Comments', 'Protected'],
      rows: sheets.map(function (s) { return [s.name, s.state === 'veryHidden' ? 'very hidden' : s.state, String(s.hiddenRows), String(s.hiddenCols), String(s.comments), s.protectedSheet ? 'yes' : '']; }) });
    if (sheets.some(function (s) { return s.protectedSheet; })) info('Sheet protection is on for ' + sheets.filter(function (s) { return s.protectedSheet; }).map(function (s) { return '“' + s.name + '”'; }).join(', ') + '. Protection stops accidental edits; it is not encryption and the content is readable.');
    if (/<workbookProtection\b/.test(wbXml)) info('The workbook structure is protected (sheets cannot be added, moved or unhidden without the password). This is not encryption.');
    var hiddenNames = (wbXml.match(/<definedName\b[^>]*\shidden="(?:1|true)"/g) || []).length;
    if (hiddenNames) info(plural(hiddenNames, 'hidden defined name', 'hidden defined names') + ' in the workbook.');
    var fv = /<fileVersion\b([^>]*)\/?>/.exec(wbXml);
    if (fv && attr(fv[1], 'appName')) out.fileVersion = { appName: attr(fv[1], 'appName'), lastEdited: attr(fv[1], 'lastEdited'), lowestEdited: attr(fv[1], 'lowestEdited') };
    var ext = names.filter(function (n) { return /^xl\/externalLinks\/[^/]+\.xml$/.test(n); }).length;
    if (ext) info('The workbook links to ' + plural(ext, 'other workbook', 'other workbooks') + '. Linked cells show the values stored in this file, which may be out of date.');
    if (names.some(function (n) { return /^xl\/connections\.xml$/.test(n); })) info('The workbook defines data connections to outside sources.');

    // text stored but no longer used by any cell
    var ss = (await read('xl/sharedStrings.xml')) || '', sis = [], si, sre2 = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    while ((si = sre2.exec(ss))) sis.push(xdec(C, (si[1].match(/<t(?:\s[^>]*)?>[^<]*<\/t>/g) || []).map(function (x) { return x.replace(/<[^>]+>/g, ''); }).join('')));
    sharedTotal = sis.length;
    var left = []; for (i = 0; i < sis.length; i++) if (!used[i] && sis[i].trim()) left.push(sis[i]);
    out.leftoverStrings = left;
    if (left.length) {
      warn(plural(left.length, 'text value is', 'text values are') + ' stored in the workbook but no cell uses ' + (left.length === 1 ? 'it' : 'them') + ': “' + clip(left.join(' … '), 120) + '”. These can be leftovers of cells that were deleted or overwritten.');
      sections.push({ title: 'Text stored but not used by any cell', kind: 'list', rows: left.slice(0, 40).map(function (x) { return clip(x, 300); }) });
    }
    void sharedTotal;
  }

  /* ---------------------------------------------------------------- PowerPoint */
  async function inspectPptx(C, names, read, findings, sections, out) {
    function warn(t) { findings.push({ level: 'warn', text: t }); }
    function info(t) { findings.push({ level: 'info', text: t }); }
    var pres = (await read('ppt/presentation.xml')) || '', rel = (await read('ppt/_rels/presentation.xml.rels')) || '', relMap = {}, rm, rre = /<Relationship\b([^>]*)\/?>/g;
    while ((rm = rre.exec(rel))) relMap[attr(rm[1], 'Id')] = xdec(C, attr(rm[1], 'Target') || '');
    var order = [], sm, sre = /<p:sldId\b([^>]*)\/?>/g;
    while ((sm = sre.exec(pres))) { var t = relMap[attr(sm[1], 'r:id')]; if (t) order.push(resolve('ppt/presentation.xml', t)); }
    var slides = [], i;
    for (i = 0; i < order.length; i++) {
      var x = (await read(order[i])) || '', root = /<p:sld\b([^>]*)>/.exec(x), hidden = !!(root && /\sshow="(?:0|false)"/.test(' ' + root[1]));
      var texts = (x.match(/<a:t>[^<]*<\/a:t>/g) || []).map(function (q) { return xdec(C, q.replace(/<[^>]+>/g, '')); }).join(' ').trim();
      var rx = (await read(dirOf(order[i]) + '_rels/' + order[i].slice(dirOf(order[i]).length) + '.rels')) || '', notes = '', nm = /Target="([^"]*notesSlide[^"]*)"/.exec(rx);
      if (nm) { var nx = await read(resolve(order[i], xdec(C, nm[1]))); if (nx) notes = (nx.match(/<a:t>[^<]*<\/a:t>/g) || []).map(function (q) { return xdec(C, q.replace(/<[^>]+>/g, '')); }).join(' ').trim(); }
      slides.push({ n: i + 1, hidden: hidden, text: texts, notes: notes });
    }
    out.slides = slides;
    var hiddenS = slides.filter(function (s) { return s.hidden; });
    if (hiddenS.length) warn(plural(hiddenS.length, 'slide is', 'slides are') + ' hidden (slide ' + hiddenS.map(function (s) { return s.n; }).join(', ') + '). Hidden slides do not show in a slide show but are fully readable: “' + clip(hiddenS.map(function (s) { return s.text; }).join(' … '), 100) + '”.');
    var withNotes = slides.filter(function (s) { return s.notes; });
    if (withNotes.length) info(plural(withNotes.length, 'slide has', 'slides have') + ' speaker notes, which the audience does not see but anyone with the file can read.');
    sections.push({ title: 'Slides', kind: 'table', head: ['Slide', 'Status', 'Text', 'Speaker notes'], rows: slides.map(function (s) { return [String(s.n), s.hidden ? 'hidden' : 'shown', clip(s.text, 160), clip(s.notes, 200)]; }) });
    var authorsXml = (await read('ppt/commentAuthors.xml')) || '', au = [], am, are = /<p:cmAuthor\b([^>]*)\/?>/g;
    while ((am = are.exec(authorsXml))) au.push(xdec(C, attr(am[1], 'name') || ''));
    var nCm = 0; names.filter(function (n) { return /^ppt\/comments\/[^/]+\.xml$/.test(n); }).forEach(function () { nCm++; });
    var cmTotal = 0, ci, cn = names.filter(function (n) { return /^ppt\/comments\/[^/]+\.xml$/.test(n); });
    for (ci = 0; ci < cn.length; ci++) cmTotal += (((await read(cn[ci])) || '').match(/<p:cm\b/g) || []).length;
    out.comments = cmTotal; out.commentAuthors = au;
    if (cmTotal || au.length) info((cmTotal ? plural(cmTotal, 'comment', 'comments') : 'Comment authors') + (au.length ? ' (authors: ' + au.map(function (a) { return '“' + a + '”'; }).join(', ') + ')' : '') + ' in the presentation.');
  }

  return { inspect: inspect, readDirectory: readDirectory, resolve: resolve, clip: clip };
});
