/* PDF Qonverter - report.js
 * Builds the case report: one self-contained, printable HTML page that records what was examined, what was found,
 * and what the tool did to the file. No DOM, no network, no external resources, so it runs in Node for tests.
 * Every piece of text that comes from the examined file is escaped before it is written into the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
  function pad(n) { return String(n).padStart(2, '0'); }
  /** 2026-11-23 03:05:09 UTC+00:00, from a Date, in the computer's own time zone. */
  function stamp(d) {
    var off = -d.getTimezoneOffset(), sign = off < 0 ? '-' : '+', a = Math.abs(off);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' UTC' + sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }
  function hashCell(h) { return h ? '<span class="hash">' + esc(h) + '</span>' : '<span class="muted">not computed</span>'; }
  function kv(rows) {
    var r = rows.filter(function (x) { return x[1] !== '' && x[1] != null; });
    return r.length ? '<table class="kv">' + r.map(function (x) { return '<tr><th>' + esc(x[0]) + '</th><td>' + x[1] + '</td></tr>'; }).join('') + '</table>' : '';
  }

  /**
   * d: {
   *   tool:{name, version}, generated: Date, caseRef, examiner, fmtDate(fn),
   *   evidence:{name, size, pages, hash, version, linearized, info, xmp, findings:[{level,text}],
   *             revisions:[{index, size, addedBytes, xrefOffset, hash, producer, modDate, pages, error}],
   *             trailing:{offset, bytes, hash}|null},
   *   log:[{time: Date, type, text, files:[{role, name, size, hash}]}]
   * } -> html string
   */
  function build(d) {
    var ev = d.evidence, fd = d.fmtDate || function (x) { return x; }, tool = d.tool || { name: 'PDF Qonverter', version: '' };
    var gen = d.generated || new Date(), info = ev.info || {}, xmp = ev.xmp || {}, revs = ev.revisions || [], finds = ev.findings || [], log = d.log || [];
    var h = '';

    h += '<header><h1>Case report</h1><p class="sub">PDF examination record</p>' +
      kv([['Case reference', d.caseRef ? esc(d.caseRef) : '<span class="blank"></span>'], ['Examiner', d.examiner ? esc(d.examiner) : '<span class="blank"></span>'],
        ['Report created', esc(stamp(gen)) + ' <span class="muted">(this computer’s clock, not independently verified)</span>'],
        ['Tool', esc(tool.name + (tool.version ? ' ' + tool.version : '')) + ' <span class="muted">(prototype; runs offline in the browser)</span>']]) + '</header>';

    h += '<section><h2>1. Item examined</h2>' + kv([
      ['File name', esc(ev.name)],
      ['Size', esc(fmtBytes(ev.size)) + ' (' + esc(Number(ev.size).toLocaleString('en-US')) + ' bytes)'],
      ['SHA-256', hashCell(ev.hash)],
      ['PDF version', esc(ev.version || 'unknown') + (ev.linearized ? ' · linearized' : '')],
      ['Pages', esc(ev.pages)]
    ]) + '<p class="muted">The hash is of the file exactly as it was opened, before anything was done to it. Compare it with the hash recorded when the item was received.</p></section>';

    var warns = finds.filter(function (f) { return f.level === 'warn'; }).length;
    h += '<section><h2>2. Findings</h2>';
    if (!finds.length) h += '<p class="ok">The automatic checks found no inconsistencies in the metadata or file structure.</p>';
    else {
      h += '<p>' + esc(plural(warns, 'point to check', 'points to check') + ', ' + plural(finds.length - warns, 'note', 'notes')) + '.</p><ul class="finds">' +
        finds.map(function (f) { return '<li class="' + (f.level === 'warn' ? 'warn' : 'info') + '"><b>' + (f.level === 'warn' ? 'Check' : 'Note') + '</b> ' + esc(f.text) + '</li>'; }).join('') + '</ul>';
    }
    h += '<p class="muted">Findings are prompts for a closer look, not verdicts. A clean result is not proof that a file is genuine.</p></section>';

    h += '<section><h2>3. Document metadata</h2>' + (kv([
      ['Title', esc(info.Title)], ['Author', esc(info.Author)], ['Subject', esc(info.Subject)], ['Keywords', esc(info.Keywords)],
      ['Creator', esc(info.Creator)], ['Producer', esc(info.Producer)],
      ['Created', info.CreationDate ? esc(fd(info.CreationDate)) + ' <span class="muted">raw: ' + esc(info.CreationDate) + '</span>' : ''],
      ['Modified', info.ModDate ? esc(fd(info.ModDate)) + ' <span class="muted">raw: ' + esc(info.ModDate) + '</span>' : ''],
      ['Created (XMP)', esc(xmp.createDate)], ['Modified (XMP)', esc(xmp.modifyDate)], ['Producer (XMP)', esc(xmp.producer)], ['Tool (XMP)', esc(xmp.creatorTool)]
    ]) || '<p>The file carries no document metadata.</p>') +
      '<p class="muted">Metadata is written by whatever produced the file and can be set to anything. It shows what the file claims, not what happened.</p></section>';

    h += '<section><h2>4. Revisions stored in the file</h2>';
    if (!revs.length) h += '<p>No revision markers were found, so revisions could not be counted. The file may be damaged or use an unusual layout.</p>';
    else if (revs.length === 1) h += '<p>The file was saved once and holds a single version of the document.</p>' + revTable(revs, fd);
    else h += '<p>The file holds <b>' + revs.length + '</b> saved versions. Viewers show only the last. Each earlier version is still in the file and can be opened.</p>' + revTable(revs, fd);
    if (revs.length) h += '<p class="muted">Each hash is of the file from its first byte to the end of that revision’s <code>%%EOF</code> marker, so an extracted revision can be verified against this report.</p>';
    if (ev.trailing && ev.trailing.bytes > 0) {
      h += '<p class="warnbox"><b>Data after the final %%EOF:</b> ' + esc(plural(ev.trailing.bytes, 'byte', 'bytes')) + ' starting at byte offset ' + esc(ev.trailing.offset) +
        '. Viewers ignore it. SHA-256 of those bytes: ' + hashCell(ev.trailing.hash) + '</p>';
    }
    h += '</section>';

    var n = 5;
    if (ev.signatures) {
      h += '<section><h2>5. Digital signatures</h2><p>The file carries <b>' + ev.signatures.signatures.length + '</b> digital ' + (ev.signatures.signatures.length === 1 ? 'signature' : 'signatures') + '.</p>';
      ev.signatures.signatures.forEach(function (g) { h += '<h3>' + esc(g.label) + '</h3>' + kv(g.rows.map(function (r) { return [r[0], esc(r[1])]; })); });
      h += '<ul class="finds">' + ev.signatures.findings.map(function (f) { return '<li class="' + (f.level === 'warn' ? 'warn' : 'info') + '"><b>' + (f.level === 'warn' ? 'Check' : 'Note') + '</b> ' + esc(f.text) + '</li>'; }).join('') + '</ul></section>';
      n = 6;
    }
    h += logSection(String(n), log);

    h += '<section class="method"><h2>' + (n + 1) + '. What this report does and does not show</h2><ul>' +
      '<li>Hashes are SHA-256, computed on this computer by the browser from the exact bytes of each file.</li>' +
      '<li>Revisions are found by counting <code>%%EOF</code> markers that follow a <code>startxref</code> entry. Linearized files, which legitimately end twice, are counted once.</li>' +
      (ev.signatures ? '<li>Signature checks compare the signed bytes with the hash stored in the signature and verify RSA signatures against the certificate inside the file. They do not check that a certificate is trusted, in date at the time of signing against an independent clock, or unrevoked, and ECDSA and RSA-PSS signatures are not verified.</li>' : '') + '<li>Several revisions are normal for signed or form-filled files. They show that a file was changed and saved on top of earlier content, not who changed it or why.</li>' +
      '<li>Dates and producer names come from the file itself and can be forged. A file with consistent metadata can still be altered.</li>' +
      '<li>This tool is a working prototype and has not been validated as forensic software. Confirm anything important with a validated tool before relying on it.</li></ul></section>';

    h += '<section class="sign"><div><span class="blank wide"></span><br>Examiner signature</div><div><span class="blank wide"></span><br>Date</div></section>';

    return page('Case report - ' + ev.name, tool, h);
  }

  function logSection(num, log) {
    var h = '<section><h2>' + num + '. Activity log for this session</h2>';
    if (!log.length) h += '<p>Nothing else was done in this session.</p>';
    else {
      h += '<table class="grid"><thead><tr><th>Time</th><th>Action</th><th>Files and SHA-256</th></tr></thead><tbody>' + log.map(function (e) {
        return '<tr><td class="nowrap">' + esc(stamp(e.time)) + '</td><td>' + esc(e.text) + '</td><td>' +
          (e.files || []).map(function (f) { return '<div><b>' + esc(f.role) + ':</b> ' + esc(f.name) + (f.size != null ? ' <span class="muted">(' + esc(fmtBytes(f.size)) + ')</span>' : '') + '<br>' + hashCell(f.hash) + '</div>'; }).join('') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    return h + '<p class="muted">The log lives only in this browser tab. It is lost when the tab is closed, so export the report before closing. A converted or saved file is a new file with a new hash; the examined original is never changed.</p></section>';
  }

  function sectionHtml(s) {
    var h = '<h3>' + esc(s.title) + '</h3>';
    if (s.kind === 'kv') return h + (kv((s.rows || []).map(function (r) { return [r[0], esc(r[1])]; })) || '<p class="muted">' + esc(s.empty || 'Nothing to show.') + '</p>');
    if (s.kind === 'list') return h + '<ul class="plain">' + (s.rows || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    return h + '<table class="grid"><thead><tr>' + (s.head || []).map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (s.rows || []).map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }

  /**
   * Case report for an Office file (output of QOffice.inspect).
   * d: { tool, generated, caseRef, examiner, file:{name,size,hash,kindName,trailing:{offset,bytes,hash}|null}, findings, sections, log }
   */
  function buildOffice(d) {
    var f = d.file, gen = d.generated || new Date(), tool = d.tool || { name: 'PDF Qonverter', version: '' }, finds = d.findings || [], log = d.log || [];
    var warns = finds.filter(function (x) { return x.level === 'warn'; }).length, h = '';
    h += '<header><h1>Case report</h1><p class="sub">Office file examination record</p>' +
      kv([['Case reference', d.caseRef ? esc(d.caseRef) : '<span class="blank"></span>'], ['Examiner', d.examiner ? esc(d.examiner) : '<span class="blank"></span>'],
        ['Report created', esc(stamp(gen)) + ' <span class="muted">(this computer\u2019s clock, not independently verified)</span>'],
        ['Tool', esc(tool.name + (tool.version ? ' ' + tool.version : '')) + ' <span class="muted">(prototype; runs offline in the browser)</span>']]) + '</header>';
    h += '<section><h2>1. Item examined</h2>' + kv([['File name', esc(f.name)], ['Type', esc(f.kindName)], ['Size', esc(fmtBytes(f.size)) + ' (' + esc(Number(f.size).toLocaleString('en-US')) + ' bytes)'], ['SHA-256', hashCell(f.hash)]]) +
      '<p class="muted">The hash is of the file exactly as it was opened. Compare it with the hash recorded when the item was received.</p></section>';
    h += '<section><h2>2. Findings</h2>';
    if (!finds.length) h += '<p class="ok">The automatic checks found nothing to point out.</p>';
    else h += '<p>' + esc(plural(warns, 'point to check', 'points to check') + ', ' + plural(finds.length - warns, 'note', 'notes')) + '.</p><ul class="finds">' +
      finds.map(function (x) { return '<li class="' + (x.level === 'warn' ? 'warn' : 'info') + '"><b>' + (x.level === 'warn' ? 'Check' : 'Note') + '</b> ' + esc(x.text) + '</li>'; }).join('') + '</ul>';
    h += '<p class="muted">Findings are prompts for a closer look, not verdicts. A clean result is not proof that a file is genuine or unaltered.</p></section>';
    h += '<section><h2>3. What the file contains</h2>' + (d.sections || []).map(sectionHtml).join('') + '</section>';
    if (f.trailing && f.trailing.bytes > 0) {
      h += '<p class="warnbox"><b>Data after the end of the zip container:</b> ' + esc(plural(f.trailing.bytes, 'byte', 'bytes')) + ' starting at byte offset ' + esc(f.trailing.offset) + '. Office ignores it. SHA-256 of those bytes: ' + hashCell(f.trailing.hash) + '</p>';
    }
    h += logSection('4', log);
    h += '<section class="method"><h2>5. What this report does and does not show</h2><ul>' +
      '<li>The file was read as the zip container of XML parts that it is. Nothing was opened in Word, Excel or PowerPoint and no macro was run.</li>' +
      '<li>Dates, names and company fields are written by the program that made the file and can be set to anything. They show what the file claims, not what happened.</li>' +
      '<li>Tracked changes, comments, hidden text, hidden sheets and slides, and leftover text are shown because they are stored in the file. Their presence says the content existed at some point, not who wanted it kept or removed.</li>' +
      '<li>A part dated after the claimed modification date, or a part nothing refers to, is a reason to look closer. It is not proof of tampering, because many ordinary tools re-save files.</li>' +
      '<li>This tool is a working prototype and has not been validated as forensic software. Confirm anything important with a validated tool before relying on it.</li></ul></section>';
    h += '<section class="sign"><div><span class="blank wide"></span><br>Examiner signature</div><div><span class="blank wide"></span><br>Date</div></section>';
    return page('Case report - ' + f.name, tool, h);
  }

  function page(title, tool, body) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="generator" content="' + esc(tool.name) + '"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><main>' + body + '</main></body></html>';
  }

  function revTable(revs, fd) {
    return '<table class="grid"><thead><tr><th>#</th><th>Size</th><th>Added</th><th>Producer · modified</th><th>SHA-256 of this revision</th></tr></thead><tbody>' +
      revs.map(function (r, i) {
        var prev = revs[i - 1], changed = prev && !prev.error && !r.error && prev.producer !== r.producer;
        var det = r.error ? '<span class="muted">unreadable</span>' : (r.producer == null && r.modDate == null) ? '<span class="muted">not read</span>' :
          '<span class="' + (changed ? 'changed' : '') + '">' + esc(r.producer || 'no producer') + '</span>' + (changed ? ' <b class="chg">producer changed</b>' : '') + '<br><span class="muted">' + esc(r.modDate ? fd(r.modDate) : 'no date') + '</span>';
        return '<tr><td>' + esc(r.index) + '</td><td class="nowrap">' + esc(fmtBytes(r.size)) + '</td><td class="nowrap">+' + esc(fmtBytes(r.addedBytes)) + '</td><td>' + det + '</td><td>' + hashCell(r.hash) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  var CSS = [
    ':root{color-scheme:light}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:#f3f3f3;color:#1b1b1b;font:14px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif}',
    'main{max-width:820px;margin:24px auto;padding:36px 44px;background:#fff;border:1px solid #ddd}',
    'h1{margin:0;font-size:26px;font-weight:600}',
    'h2{margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid #ccc;font-size:16px;font-weight:600}',
    '.sub{margin:2px 0 14px;color:#555}',
    'p{margin:8px 0}',
    '.muted{color:#666;font-size:12.5px}',
    'table{border-collapse:collapse;width:100%}',
    'table.kv th{width:150px;padding:3px 10px 3px 0;text-align:left;vertical-align:top;font-weight:600;color:#444}',
    'table.kv td{padding:3px 0;overflow-wrap:anywhere}',
    'table.grid{margin:8px 0;font-size:13px}',
    'table.grid th,table.grid td{padding:6px 8px;border:1px solid #ccc;text-align:left;vertical-align:top}',
    'table.grid th{background:#f0f0f0}',
    'tr{break-inside:avoid}',
    '.hash{font:12px/1.4 Consolas,"Courier New",monospace;overflow-wrap:anywhere;word-break:break-all}',
    '.nowrap{white-space:nowrap}',
    '.finds{margin:8px 0;padding:0;list-style:none}',
    '.finds li{margin:6px 0;padding:8px 10px;border-left:4px solid #888;background:#f6f6f6}',
    '.finds li.warn{border-color:#b45309;background:#fff7ec}',
    '.finds li b{margin-right:6px;font-size:12px;text-transform:uppercase;letter-spacing:.03em}',
    '.ok{padding:8px 10px;border-left:4px solid #107c10;background:#f1faf1}',
    '.warnbox{padding:8px 10px;border-left:4px solid #b45309;background:#fff7ec}',
    '.changed,.chg{color:#b45309}',
    '.blank{display:inline-block;min-width:180px;border-bottom:1px solid #777}',
    '.blank.wide{min-width:260px;height:34px}',
    '.sign{display:flex;gap:40px;margin-top:34px;color:#555;font-size:12.5px}',
    'code{font:12px Consolas,"Courier New",monospace}',
    '.method ul,ul.plain{margin:6px 0;padding-left:20px}',
    'h3{margin:16px 0 4px;font-size:14px;font-weight:600}',
    '@page{size:A4;margin:16mm}',
    '@media print{body{background:#fff}main{margin:0;padding:0;border:0;max-width:none}h2{break-after:avoid}section{break-inside:auto}}'
  ].join('\n');

  return { build: build, buildOffice: buildOffice, esc: esc, stamp: stamp, fmtBytes: fmtBytes };
});
