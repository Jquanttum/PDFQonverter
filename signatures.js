/* PDF Qonverter - signatures.js
 * Reads the digital signatures in a PDF and answers the questions a viewer's green tick hides:
 *   - which bytes does each signature actually cover, and is anything in the file outside that range?
 *   - do the covered bytes still hash to the value the signer signed (digest check)?
 *   - does the signature verify mathematically against the certificate stored in it (RSA only)?
 *   - what does the signature container itself say (signer, dates, reason), and is anything hidden in its padding?
 * It does NOT check that the certificate is trusted, that it chains to a known authority, whether it was revoked,
 * or who the signer really is. A valid result here means "these bytes are unchanged since someone holding this key
 * signed them", nothing more. No DOM and no network; hashing and RSA come from Web Crypto passed in by the caller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QSig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function utc(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC'; }
  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }

  /* ---------------------------------------------------------------- DER (just enough to read a CMS signature) */
  function der(b, off, limit) {
    limit = limit == null ? b.length : limit;
    if (off + 2 > limit) throw new Error('truncated');
    var tag = b[off], l = b[off + 1], hdr = 2;
    if (l === 0x80) throw new Error('indefinite length (BER) is not supported');
    if (l & 0x80) {
      var n = l & 0x7f;
      if (n > 4 || off + 2 + n > limit) throw new Error('bad length');
      l = 0;
      for (var i = 0; i < n; i++) l = l * 256 + b[off + 2 + i];
      hdr = 2 + n;
    }
    if (off + hdr + l > limit) throw new Error('length runs past the end');
    return { tag: tag, hdr: hdr, len: l, start: off + hdr, end: off + hdr + l, off: off };
  }
  function kids(b, n) { var out = [], p = n.start; while (p < n.end) { var c = der(b, p, n.end); out.push(c); p = c.end; } return out; }
  function oidOf(b, n) {
    var p = n.start, parts = [], first = b[p++];
    parts.push(Math.floor(first / 40), first % 40);
    var v = 0;
    for (; p < n.end; p++) { v = v * 128 + (b[p] & 0x7f); if (!(b[p] & 0x80)) { parts.push(v); v = 0; } }
    return parts.join('.');
  }
  function strOf(b, n) {
    var s = '', i;
    if (n.tag === 0x1e) { for (i = n.start; i + 1 < n.end; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; }
    if (n.tag === 0x0c) return new TextDecoder('utf-8').decode(b.subarray(n.start, n.end));
    for (i = n.start; i < n.end; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function timeOf(b, n) {
    var s = strOf(b, n), m;
    if (n.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s))) { var y = +m[1]; return new Date(Date.UTC(y < 50 ? 2000 + y : 1900 + y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))); }
    if (n.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?/.exec(s))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return null;
  }
  var OID = {
    cn: '2.5.4.3', o: '2.5.4.10', ou: '2.5.4.11', c: '2.5.4.6', l: '2.5.4.7', st: '2.5.4.8', email: '1.2.840.113549.1.9.1',
    signedData: '1.2.840.113549.1.7.2', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5'
  };
  var NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'E' };
  var HASH = { '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.4': 'SHA-224', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512' };
  var RSA_SIG = { '1.2.840.113549.1.1.1': 1, '1.2.840.113549.1.1.5': 1, '1.2.840.113549.1.1.11': 1, '1.2.840.113549.1.1.12': 1, '1.2.840.113549.1.1.13': 1 };

  function parseName(b, n) {
    var parts = [], map = {};
    kids(b, n).forEach(function (rdn) {
      kids(b, rdn).forEach(function (atv) {
        var k = kids(b, atv), o = oidOf(b, k[0]), label = NAMES[o] || o, v = strOf(b, k[1]);
        parts.push(label + '=' + v); if (!map[label]) map[label] = v;
      });
    });
    return { dn: parts.reverse().join(','), cn: map.CN || '', o: map.O || '', c: map.C || '', map: map };
  }
  function parseCert(b, n) {
    var tbs = kids(b, n)[0], k = kids(b, tbs), i = 0;
    if (k[i].tag === 0xA0) i++;
    var serial = k[i++]; i++;                      // serial, signature algorithm
    var issuer = k[i++], validity = k[i++], subject = k[i++], spki = k[i++], vt = kids(b, validity);
    return {
      serial: hex(b.subarray(serial.start, serial.end)).replace(/^(00)+(?=.)/, ''), issuer: parseName(b, issuer), subject: parseName(b, subject),
      issuerRaw: hex(b.subarray(issuer.off, issuer.end)), serialRaw: hex(b.subarray(serial.start, serial.end)),
      notBefore: timeOf(b, vt[0]), notAfter: timeOf(b, vt[1]), spki: b.slice(spki.off, spki.end)
    };
  }

  /** CMS SignedData -> signer, certificates, signed attributes. Throws on anything it cannot read. */
  function parseCms(b) {
    var ci = der(b, 0), top = kids(b, ci);
    if (ci.tag !== 0x30 || oidOf(b, top[0]) !== OID.signedData) throw new Error('not a CMS SignedData structure');
    var sd = kids(b, kids(b, top[1])[0]), certs = [], signerInfos = null, i;
    for (i = 0; i < sd.length; i++) {
      if (sd[i].tag === 0xA0) kids(b, sd[i]).forEach(function (c) { if (c.tag === 0x30) { try { certs.push(parseCert(b, c)); } catch (e) { /* skip unreadable certificate */ } } });
      else if (sd[i].tag === 0x31 && i === sd.length - 1) signerInfos = sd[i];
    }
    if (!signerInfos) throw new Error('no signer information');
    var si = kids(b, kids(b, signerInfos)[0]), j = 1, sid = si[j++], digestAlg = si[j++], attrs = null, sigAlg, sig;
    if (si[j].tag === 0xA0) attrs = si[j++];
    sigAlg = si[j++]; sig = si[j++];
    var signed = {}, signedRaw = null;
    if (attrs) {
      signedRaw = b.slice(attrs.off, attrs.end); signedRaw[0] = 0x31;      // signed over as an ordinary SET
      kids(b, attrs).forEach(function (a) { var ak = kids(b, a), v = kids(b, ak[1])[0]; signed[oidOf(b, ak[0])] = v ? { node: v } : null; });
    }
    var digestOid = oidOf(b, kids(b, digestAlg)[0]);
    var signer = null;
    if (sid.tag === 0x30) {
      var sk = kids(b, sid), ih = hex(b.subarray(sk[0].off, sk[0].end)), sn = hex(b.subarray(sk[1].start, sk[1].end));
      signer = certs.filter(function (c) { return c.issuerRaw === ih && c.serialRaw === sn; })[0] || null;
    }
    if (!signer && certs.length) signer = certs[0];
    return {
      certs: certs, signer: signer, digestOid: digestOid, hash: HASH[digestOid] || null, sigOid: oidOf(b, kids(b, sigAlg)[0]),
      signature: b.slice(sig.start, sig.end), signedAttrsRaw: signedRaw,
      messageDigest: signed[OID.messageDigest] ? b.slice(signed[OID.messageDigest].node.start, signed[OID.messageDigest].node.end) : null,
      signingTime: signed[OID.signingTime] ? timeOf(b, signed[OID.signingTime].node) : null,
      derLength: ci.end
    };
  }

  /* ---------------------------------------------------------------- the PDF side */
  function latin1(bytes) { return new TextDecoder('latin1').decode(bytes); }
  function readString(text, key) {
    var m = new RegExp('/' + key + '\\s*([(<])').exec(text);
    if (!m) return '';
    var i = m.index + m[0].length - 1, out = [];
    if (text[i] === '<') {
      var end = text.indexOf('>', i), h = text.slice(i + 1, end).replace(/\s+/g, ''), bytes = [];
      for (var k = 0; k + 1 < h.length; k += 2) bytes.push(parseInt(h.substr(k, 2), 16));
      return bytesToText(bytes);
    }
    var depth = 0;
    for (i = i; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\\') { var nx = text[++i]; out.push(nx === 'n' ? 10 : nx === 'r' ? 13 : nx === 't' ? 9 : nx.charCodeAt(0)); continue; }
      if (ch === '(') { if (depth++ === 0) continue; }
      if (ch === ')') { if (--depth === 0) break; }
      out.push(ch.charCodeAt(0) & 255);
    }
    return bytesToText(out);
  }
  function bytesToText(a) {
    if (a.length >= 2 && a[0] === 0xFE && a[1] === 0xFF) { var s = ''; for (var i = 2; i + 1 < a.length; i += 2) s += String.fromCharCode((a[i] << 8) | a[i + 1]); return s; }
    return String.fromCharCode.apply(null, a);
  }
  function readName(text, key) { var m = new RegExp('/' + key + '\\s*/([^\\s/<>\\[\\]()]+)').exec(text); return m ? m[1] : ''; }
  function pdfDate(s) {
    var m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?(?:([Zz])|([+-])(\d\d)'?(\d\d)?'?)?/.exec(s || '');
    if (!m) return null;
    var t = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
    if (m[8]) t -= (m[8] === '-' ? -1 : 1) * ((+m[9]) * 60 + (+m[10] || 0)) * 60000;
    return new Date(t);
  }
  function cleanHexGap(bytes, a, b) {
    // the placeholder between the two signed ranges must be <hex digits>
    if (bytes[a] !== 0x3C || bytes[b - 1] !== 0x3E) return null;
    var h = latin1(bytes.subarray(a + 1, b - 1)).replace(/\s+/g, '');
    if (!/^[0-9A-Fa-f]*$/.test(h) || h.length % 2) return null;
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  /** Structure only (no hashing): every signature's ByteRange, the dictionary's own claims, and layout problems. */
  function scan(bytes) {
    var text = latin1(bytes), n = bytes.length, re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g, m, sigs = [];
    while ((m = re.exec(text))) {
      var br = [+m[1], +m[2], +m[3], +m[4]], o = text.lastIndexOf(' obj', m.index), s0 = o < 0 ? Math.max(0, m.index - 200) : Math.max(0, text.lastIndexOf('\n', o) + 1);
      var e0 = text.indexOf('endobj', m.index), objText = text.slice(s0, e0 < 0 ? m.index + 400 : e0);
      var gapStart = br[0] + br[1], gapEnd = br[2], problems = [];
      var plain = objText.replace(/\/Contents\s*<[^>]*>/, '/Contents <...>');
      var sig = {
        index: sigs.length + 1, byteRange: br, offset: m.index, name: readString(plain, 'Name'), reason: readString(plain, 'Reason'), location: readString(plain, 'Location'),
        contactInfo: readString(plain, 'ContactInfo'), claimedTime: readString(plain, 'M'), filter: readName(plain, 'Filter'), subFilter: readName(plain, 'SubFilter'),
        isTimestamp: /ETSI\.RFC3161/.test(plain) || /\/Type\s*\/DocTimeStamp/.test(plain), fileLength: n, problems: problems
      };
      sig.claimedDate = pdfDate(sig.claimedTime);
      if (br[0] !== 0) problems.push('the first signed range does not start at byte 0 (it starts at ' + br[0] + ')');
      if (!(br[1] > 0 && br[2] >= br[1] + 2)) problems.push('the ranges overlap or the gap for the signature is too small');
      if (br[2] + br[3] > n) problems.push('the ranges run past the end of the file (' + (br[2] + br[3]) + ' > ' + n + ')');
      sig.coveredEnd = br[2] + br[3];
      sig.after = Math.max(0, n - sig.coveredEnd);
      sig.coversWhole = sig.after === 0 && problems.length === 0;
      sig.contents = problems.length ? null : cleanHexGap(bytes, gapStart, gapEnd);
      if (!problems.length && !sig.contents) problems.push('the gap between the signed ranges is not a clean <hex> signature value');
      sigs.push(sig);
    }
    return sigs;
  }

  /* ---------------------------------------------------------------- the checks that need hashing */
  async function check(bytes, sig, helpers, now) {
    var r = { cms: null, cmsError: '', signer: null, hash: '', digest: 'not checked', rsa: 'not checked', padding: 0, notes: [] };
    if (!sig.contents) return r;
    var c = sig.contents;
    try { r.cms = parseCms(c); } catch (e) { r.cmsError = e.message; return r; }
    var cms = r.cms;
    for (var i = cms.derLength; i < c.length; i++) if (c[i] !== 0) r.padding++;
    r.hash = cms.hash || '';
    r.signer = cms.signer && {
      cn: cms.signer.subject.cn, o: cms.signer.subject.o, c: cms.signer.subject.c, dn: cms.signer.subject.dn, issuer: cms.signer.issuer.dn, serial: cms.signer.serial,
      notBefore: cms.signer.notBefore, notAfter: cms.signer.notAfter, selfSigned: cms.signer.subject.dn === cms.signer.issuer.dn
    };
    if (sig.isTimestamp) { r.digest = 'not checked (document timestamp)'; r.rsa = 'not checked'; return r; }
    if (!/detached|CAdES/i.test(sig.subFilter) && sig.subFilter) { r.digest = 'not checked (' + sig.subFilter + ' is not supported)'; return r; }
    if (!cms.hash || !helpers || !helpers.digest) { r.digest = 'not checked (' + (cms.hash ? 'no hashing available' : 'unknown hash algorithm') + ')'; return r; }
    var br = sig.byteRange, covered = new Uint8Array(br[1] + br[3]);
    covered.set(bytes.subarray(br[0], br[0] + br[1]), 0); covered.set(bytes.subarray(br[2], br[2] + br[3]), br[1]);
    r.computed = hex(new Uint8Array(await helpers.digest(cms.hash, covered)));
    if (cms.messageDigest) { r.stored = hex(cms.messageDigest); r.digest = r.stored === r.computed ? 'match' : 'MISMATCH'; }
    else r.digest = 'not checked (signature has no stored digest)';
    if (cms.signedAttrsRaw && cms.signer && helpers.verifyRsa) {
      if (!RSA_SIG[cms.sigOid]) r.rsa = 'not checked (' + (cms.sigOid === '1.2.840.113549.1.1.10' ? 'RSA-PSS' : 'this key type') + ' is not supported)';
      else {
        try { r.rsa = (await helpers.verifyRsa(cms.signer.spki, cms.hash, cms.signature, cms.signedAttrsRaw)) ? 'valid' : 'INVALID'; }
        catch (e) { r.rsa = 'not checked (' + e.message + ')'; }
      }
    }
    return r;
  }

  /** Web Crypto helpers for callers: pass crypto.subtle (browser) or require('crypto').webcrypto.subtle (Node). */
  function webCryptoHelpers(subtle) {
    return {
      digest: function (name, data) { return subtle.digest(name, data); },
      verifyRsa: async function (spki, hash, signature, data) {
        var key = await subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: hash }, false, ['verify']);
        return subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
      }
    };
  }

  /**
   * analyse(bytes, { helpers, revisions, now }) -> { signatures:[...], findings:[{level,text}] }
   * revisions: the list from QEngine.scanRevisions (each with .end), used to say "after revision N".
   */
  async function analyse(bytes, opts) {
    opts = opts || {};
    var now = opts.now || new Date(), found = scan(bytes), findings = [], out = [], i;
    function warn(t) { findings.push({ level: 'warn', text: t }); }
    function info(t) { findings.push({ level: 'info', text: t }); }
    if (!found.length) return { signatures: [], findings: [{ level: 'info', text: 'The file has no digital signatures.' }] };
    for (i = 0; i < found.length; i++) {
      var s = found[i], k = await check(bytes, s, opts.helpers, now), who = k.signer && k.signer.cn ? '\u201c' + k.signer.cn + '\u201d' : 'signature ' + s.index;
      var label = (s.isTimestamp ? 'Document timestamp ' : 'Signature ') + s.index + (k.signer && k.signer.cn ? ' (' + k.signer.cn + ')' : s.name ? ' (' + s.name + ')' : '');
      var rec = { index: s.index, isTimestamp: s.isTimestamp, byteRange: s.byteRange, coveredEnd: s.coveredEnd, after: s.after, coversWhole: s.coversWhole, fileLength: s.fileLength, problems: s.problems,
        subFilter: s.subFilter, name: s.name, reason: s.reason, location: s.location, contactInfo: s.contactInfo, claimedTime: s.claimedTime, claimedDate: s.claimedDate,
        signer: k.signer, hash: k.hash, digest: k.digest, rsa: k.rsa, computed: k.computed || '', stored: k.stored || '', cmsError: k.cmsError, padding: k.padding, label: label, rows: [] };
      out.push(rec);
      // revision the signature ends at
      if (opts.revisions && !s.problems.length) {
        var ri = -1; opts.revisions.forEach(function (r, x) { if (r.end === s.coveredEnd) ri = x; });
        rec.revision = ri >= 0 ? ri + 1 : 0;
      }
      if (s.problems.length) warn(label + ': the signed ranges are malformed (' + s.problems.join('; ') + '). A signature like this cannot protect the file.');
      if (k.cmsError) warn(label + ': the signature value could not be read (' + k.cmsError + ').');
      if (k.digest === 'MISMATCH') warn(label + ': the bytes it covers have CHANGED since signing. The hash of those bytes is ' + k.computed.slice(0, 16) + '\u2026 but the signature recorded ' + k.stored.slice(0, 16) + '\u2026. Something inside the signed part of the file was altered.');
      else if (k.digest === 'match') info(label + ': the bytes it covers still match the hash the signer signed (' + k.hash + '), so nothing inside the signed range has changed.');
      if (k.rsa === 'INVALID') warn(label + ': the signature does not verify against the public key in its own certificate. It was forged, damaged or built wrongly.');
      else if (k.rsa === 'valid') info(label + ': the signature verifies mathematically against the key in the certificate stored inside it.');
      if (!s.problems.length && s.after > 0) {
        var later = found.filter(function (o) { return o.index !== s.index && !o.problems.length && o.coveredEnd > s.coveredEnd && o.coveredEnd >= s.fileLength - 0; });
        var revText = rec.revision ? ' (it ends at revision ' + rec.revision + (opts.revisions ? ' of ' + opts.revisions.length : '') + ')' : '';
        if (later.length) info(label + ' covers the file only up to byte ' + s.coveredEnd + revText + '. ' + plural(s.after, 'later byte is', 'later bytes are') + ' covered by ' + later.map(function (o) { return 'signature ' + o.index; }).join(', ') + ', which is normal when several people sign one after another.');
        else warn(label + ' covers the file only up to byte ' + s.coveredEnd + revText + '; ' + plural(s.after, 'byte', 'bytes') + ' follow that are not signed by anything. A later revision was added after signing. That can be legitimate (form filling, comments) or an alteration, so extract that revision and compare.');
      } else if (!s.problems.length && !s.isTimestamp) info(label + ' covers the whole file.');
      if (k.padding > 0) warn(label + ': ' + plural(k.padding, 'non-zero byte', 'non-zero bytes') + ' sit in the padding after the signature value. Padding should be zeros. Data can be hidden there without breaking the signature.');
      if (k.signer) {
        var sg = k.signer, claimed = (k.cms && k.cms.signingTime) || s.claimedDate;
        if (claimed) {
          if (sg.notBefore && claimed < sg.notBefore) warn(label + ': it claims to be signed on ' + utc(claimed) + ', before its certificate became valid (' + utc(sg.notBefore) + ').');
          if (sg.notAfter && claimed > sg.notAfter) warn(label + ': it claims to be signed on ' + utc(claimed) + ', after its certificate expired (' + utc(sg.notAfter) + ').');
          if (claimed.getTime() > now.getTime() + 86400000) warn(label + ': the signing time (' + utc(claimed) + ') is in the future.');
        }
        if (k.cms && k.cms.signingTime && s.claimedDate && Math.abs(k.cms.signingTime - s.claimedDate) > 86400000 * 1.01) warn(label + ': the signing time inside the signature (' + utc(k.cms.signingTime) + ') differs by more than a day from the time written in the PDF (' + utc(s.claimedDate) + ').');
        if (sg.selfSigned) info(label + ': the certificate is self-signed (it vouches for itself).');
      }
      var rows = rec.rows;
      if (k.signer) { rows.push(['Signer', k.signer.cn + (k.signer.o ? ', ' + k.signer.o : '') + (k.signer.c ? ' (' + k.signer.c + ')' : '')]); rows.push(['Certificate issued by', k.signer.issuer + (k.signer.selfSigned ? ' (self-signed)' : '')]);
        rows.push(['Certificate valid', (k.signer.notBefore ? utc(k.signer.notBefore) : '?') + ' to ' + (k.signer.notAfter ? utc(k.signer.notAfter) : '?')]); }
      if (s.name) rows.push(['Name in the PDF', s.name]);
      var claimedShow = (k.cms && k.cms.signingTime) || s.claimedDate;
      if (claimedShow) rows.push(['Signing time (claimed)', utc(claimedShow)]);
      if (s.reason) rows.push(['Reason', s.reason]); if (s.location) rows.push(['Location', s.location]); if (s.contactInfo) rows.push(['Contact', s.contactInfo]);
      rows.push(['Signature type', s.subFilter || '(not stated)']);
      rows.push(['Covers', s.problems.length ? 'invalid ranges' : 'bytes 0\u2013' + s.coveredEnd + ' of ' + s.fileLength + (s.after ? ' (' + fmtBytes(s.after) + ' after it are NOT covered)' : ' (whole file)') + (rec.revision ? ', up to revision ' + rec.revision : '')]);
      rows.push(['Hash check', k.digest === 'match' ? 'matches (' + k.hash + ')' : k.digest === 'MISMATCH' ? 'MISMATCH: the covered bytes changed' : k.digest]);
      rows.push(['Signature maths', k.rsa === 'valid' ? 'valid against the certificate key' : k.rsa === 'INVALID' ? 'INVALID' : k.rsa]);
    }
    if (out.length > 1) info('The file carries ' + out.length + ' signatures, checked one by one.');
    info('Not checked: whether any certificate is trusted or chains to a known authority, whether it was revoked, and who the signer really is. A valid result means these bytes are unchanged since someone holding that key signed them.');
    findings.sort(function (a, b) { return (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1); });
    return { signatures: out, findings: findings };
  }

  return { analyse: analyse, scan: scan, parseCms: parseCms, webCryptoHelpers: webCryptoHelpers, der: der };
});
