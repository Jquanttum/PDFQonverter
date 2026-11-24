/* Signature check tests. Expected values come from poppler's pdfsig (tests/fixtures/signed_expected.json), not from this code. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const S = require('../signatures.js'), E = require('../engine.js');
const H = S.webCryptoHelpers(require('crypto').webcrypto.subtle);
const FX = path.join(__dirname, 'fixtures'), EXP = JSON.parse(fs.readFileSync(path.join(FX, 'signed_expected.json'), 'utf8'));
const load = n => new Uint8Array(fs.readFileSync(path.join(FX, n + '.pdf')));
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); } }
const run = (b, extra) => S.analyse(b, Object.assign({ helpers: H, revisions: E.scanRevisions(b).revisions }, extra || {}));
const ranges = s => s.byteRange[0] + ' - ' + (s.byteRange[0] + s.byteRange[1] - 1);
function fromPdfsig(x) { const m = /\[(\d+) - (\d+)\], \[(\d+) - (\d+)\]/.exec(x['Signed Ranges']); return [+m[1], +m[2] - +m[1], +m[3], +m[4] - +m[3]]; }

(async () => {
  for (const n of ['signed_ok', 'signed_appended', 'signed_tampered', 'signed_twice']) {
    const b = load(n), r = await run(b);
    await t(n + ': signature count matches pdfsig', () => assert.strictEqual(r.signatures.length, EXP[n].length));
    EXP[n].forEach((x, i) => {
      const s = r.signatures[i] || {};
      t(n + ' #' + (i + 1) + ': signer CN', () => assert.strictEqual(s.signer.cn, x['Signer Certificate Common Name']));
      t(n + ' #' + (i + 1) + ': signer DN', () => assert.strictEqual(s.signer.dn, x['Signer full Distinguished Name']));
      t(n + ' #' + (i + 1) + ': hash algorithm', () => assert.strictEqual(s.hash, x['Signing Hash Algorithm']));
      t(n + ' #' + (i + 1) + ': sub-filter', () => assert.strictEqual(s.subFilter, x['Signature Type']));
      t(n + ' #' + (i + 1) + ': signed ranges', () => assert.deepStrictEqual(s.byteRange, fromPdfsig(x)));
      t(n + ' #' + (i + 1) + ': total vs partial coverage', () => assert.strictEqual(s.coversWhole, x['Coverage'] === 'total'));
      t(n + ' #' + (i + 1) + ': digest verdict agrees with pdfsig', () => assert.strictEqual(s.digest === 'match', /Valid/.test(x['Signature Validation'])));
    });
  }
  await t('tampered: hash MISMATCH is reported as a warning', async () => {
    const r = await run(load('signed_tampered')); assert.strictEqual(r.signatures[0].digest, 'MISMATCH');
    assert(r.findings.some(f => f.level === 'warn' && /CHANGED/.test(f.text)));
  });
  await t('tampered: the signature maths itself is still valid (only the content changed)', async () => assert.strictEqual((await run(load('signed_tampered'))).signatures[0].rsa, 'valid'));
  await t('intact: digest match and RSA valid, no warnings', async () => {
    const r = await run(load('signed_ok')); assert.strictEqual(r.signatures[0].digest, 'match'); assert.strictEqual(r.signatures[0].rsa, 'valid');
    assert.strictEqual(r.findings.filter(f => f.level === 'warn').length, 0);
  });
  await t('appended: warns that bytes follow the signed range, and says which revision it ends at', async () => {
    const r = await run(load('signed_appended')), w = r.findings.filter(f => f.level === 'warn');
    assert.strictEqual(w.length, 1); assert(/652 bytes/.test(w[0].text)); assert.strictEqual(r.signatures[0].revision, 2);
  });
  await t('twice: earlier signature is partial but explained by the later one (info, not warn)', async () => {
    const r = await run(load('signed_twice')); assert.strictEqual(r.findings.filter(f => f.level === 'warn').length, 0);
    assert(r.findings.some(f => /covered by signature 2/.test(f.text)));
  });
  await t('unsigned: no signatures, plain info', async () => {
    const r = await run(load('unsigned')); assert.strictEqual(r.signatures.length, 0); assert.strictEqual(r.findings[0].level, 'info');
  });
  await t('the limits note is always present for signed files', async () => assert(/Not checked: whether any certificate is trusted/.test((await run(load('signed_ok'))).findings.map(f => f.text).join('\n'))));
  await t('works with no hashing helpers: structure only, says "not checked"', async () => {
    const r = await S.analyse(load('signed_ok'), {}); assert(/not checked/.test(r.signatures[0].digest)); assert.strictEqual(r.signatures[0].signer.cn, 'Ama Mensah (test)');
  });
  await t('non-zero bytes in the signature padding are flagged', async () => {
    const b = load('signed_ok').slice(), s = S.scan(b)[0], gapEnd = s.byteRange[2] - 2;   // last hex digits before ">"
    b[gapEnd - 1] = 0x31; b[gapEnd - 2] = 0x31;                                          // "11" -> a non-zero padding byte
    const r = await run(b); assert(r.signatures[0].padding > 0); assert(r.findings.some(f => f.level === 'warn' && /padding/.test(f.text)));
  });
  await t('malformed ByteRange (runs past end of file) is a warning, not a crash', async () => {
    const txt = Buffer.from(load('signed_ok')).toString('latin1').replace(/\/ByteRange\s*\[(\d+) (\d+) (\d+) (\d+)/, (m, a, b, c, d) => '/ByteRange [' + a + ' ' + b + ' ' + c + ' ' + (+d + 99999));
    const r = await run(new Uint8Array(Buffer.from(txt, 'latin1'))); assert(r.findings.some(f => f.level === 'warn' && /malformed/.test(f.text)));
  });
  await t('garbage bytes are not a crash', async () => { const r = await run(new Uint8Array(500).fill(7)); assert.strictEqual(r.signatures.length, 0); });
  await t('hostile text in /Reason and /Name is returned as plain text (the UI escapes it)', async () => {
    const txt = Buffer.from(load('signed_ok')).toString('latin1').replace('(I approve this contract)', '(<script>alert(1)</script>)');
    const s = S.scan(new Uint8Array(Buffer.from(txt, 'latin1')))[0]; assert.strictEqual(s.reason, '<script>alert(1)</script>');
  });
  await t('expired-certificate claim: signing time after notAfter warns', async () => {
    const r = await run(load('signed_ok'), { now: new Date('2030-01-01') });   // now is far later; signing time itself is not in the future
    assert.strictEqual(r.findings.filter(f => f.level === 'warn').length, 0);
  });
  await t('future signing time warns', async () => {
    const r = await run(load('signed_ok'), { now: new Date('2020-01-01') }); assert(r.findings.some(f => f.level === 'warn' && /in the future/.test(f.text)));
  });
  console.log('signatures.test.js: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
