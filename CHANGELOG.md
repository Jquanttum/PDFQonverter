# Changelog

## 0.4.0 - 2026-11-24
- Digital signature check (Inspect tab and case report): for each signature, the byte ranges it covers, whether anything was added after signing, whether the covered bytes still match the signed hash, RSA signature verification against the certificate inside the file, signer and certificate details, signing-time and padding checks. Does not check certificate trust, revocation or ECDSA/RSA-PSS signatures.

## 0.3.0 - 2026-11-23
- Excel conversions: Excel to PDF, Excel to CSV, CSV to Excel, PDF to Excel (hidden sheets, rows and columns reported; formula-injection protection; leading zeros kept; 1904 dates handled).
- Case report: one printable page with hashes, findings, per-revision hashes and a session activity log.
- Office file inspector for .docx, .xlsx, .pptx: tracked changes and deleted text, hidden text, hidden sheets and slides, speaker notes, leftover strings, container oddities.
- Browser tests moved into `tests/e2e`, with a runner.

## 0.2.0 - 2026-11-22
- Convert mode: images, text and Word to PDF; PDF to images, text and Word. Photo metadata (including GPS) is removed losslessly when building PDFs.

## 0.1.0 - 2026-11-21
- Offline PDF editor: mark-up, page management, true redaction with verification, Inspect tab (hidden revisions, metadata checks, SHA-256).
