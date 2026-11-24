"""Builds the signed PDFs used by tests/signatures.test.js.   python3 make_signed_fixtures.py

Needs: reportlab, cryptography, pyhanko (the independent signer), and poppler's pdfsig (the independent checker).
Everything is signed with throwaway self-signed certificates made here. All names are fictional.

  unsigned.pdf          a one-page contract, text not compressed so the tamper test can edit it
  signed_ok.pdf         signed once by "Ama Mensah (test)"
  signed_appended.pdf   signed_ok.pdf plus a later revision (something changed after signing)
  signed_tampered.pdf   signed_ok.pdf with one digit changed INSIDE the signed bytes (52,000 -> 92,000)
  signed_twice.pdf      signed by Ama, then countersigned by "Kofi Boateng (test)" in a later revision
  signed_expected.json  what pdfsig says about each file
"""
import datetime, io, json, os, re, subprocess, tempfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()


def make_identity(cn, org):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, 'GH'), x509.NameAttribute(NameOID.ORGANIZATION_NAME, org), x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime(2026, 1, 1)).not_valid_after(datetime.datetime(2027, 1, 1))
            .sign(key, hashes.SHA256()))
    kp, cp = os.path.join(TMP, cn[:3] + '.key'), os.path.join(TMP, cn[:3] + '.pem')
    open(kp, 'wb').write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    open(cp, 'wb').write(cert.public_bytes(serialization.Encoding.PEM))
    return signers.SimpleSigner.load(kp, cp)


ama = make_identity('Ama Mensah (test)', 'Test Traders Ltd')
kofi = make_identity('Kofi Boateng (test)', 'Test Suppliers Ltd')

# ---------------------------------------------------------------- the document
buf = io.BytesIO()
c = canvas.Canvas(buf, pagesize=A4, pageCompression=0)
c.setTitle('Supply contract')
c.setFont('Helvetica-Bold', 16)
c.drawString(72, 760, 'Supply contract')
c.setFont('Helvetica', 11)
c.drawString(72, 730, 'Between Test Traders Ltd and Test Suppliers Ltd.')
c.drawString(72, 710, 'Annual price: GHS 52,000 payable within 14 days.')
c.showPage()
c.save()
unsigned = buf.getvalue()
open(os.path.join(HERE, 'unsigned.pdf'), 'wb').write(unsigned)


def sign(pdf_bytes, signer, field, reason, location):
    w = IncrementalPdfFileWriter(io.BytesIO(pdf_bytes))
    meta = signers.PdfSignatureMetadata(field_name=field, reason=reason, location=location)
    out = io.BytesIO()
    signers.sign_pdf(w, meta, signer=signer, new_field_spec=fields.SigFieldSpec(field), output=out)
    return out.getvalue()


ok = sign(unsigned, ama, 'Sig1', 'I approve this contract', 'Tamale')
open(os.path.join(HERE, 'signed_ok.pdf'), 'wb').write(ok)

# a later revision made with an ordinary incremental update
w = IncrementalPdfFileWriter(io.BytesIO(ok))
w.root['/Lang'] = generic.TextStringObject('en-GH')
w.update_root()
out = io.BytesIO()
w.write(out)
open(os.path.join(HERE, 'signed_appended.pdf'), 'wb').write(out.getvalue())

# one digit changed inside the signed bytes
assert ok.count(b'GHS 52,000') == 1
open(os.path.join(HERE, 'signed_tampered.pdf'), 'wb').write(ok.replace(b'GHS 52,000', b'GHS 92,000'))

twice = sign(ok, kofi, 'Sig2', 'Countersigned', 'Kumasi')
open(os.path.join(HERE, 'signed_twice.pdf'), 'wb').write(twice)

# ---------------------------------------------------------------- what poppler says (the independent opinion)
exp = {}
for n in ['unsigned', 'signed_ok', 'signed_appended', 'signed_tampered', 'signed_twice']:
    r = subprocess.run(['pdfsig', '-nocert', os.path.join(HERE, n + '.pdf')], capture_output=True, text=True)
    sigs, cur = [], None
    for line in (r.stdout + r.stderr).splitlines():
        line = line.strip()
        if re.match(r'^Signature #\d+:', line):
            cur = {}
            sigs.append(cur)
        elif cur is not None and line.lstrip('- ') in ('Total document signed', 'Not total document signed'):
            cur['Coverage'] = 'total' if line.lstrip('- ').startswith('Total') else 'partial'
        elif cur is not None and ':' in line:
            k, v = line.lstrip('- ').split(':', 1)
            cur[k.strip()] = v.strip()
    exp[n] = sigs
json.dump(exp, open(os.path.join(HERE, 'signed_expected.json'), 'w'), indent=1)
for n, s in exp.items():
    print(n, [(x.get('Signature Validation'), x.get('Coverage'), x.get('Signed Ranges')) for x in s])
