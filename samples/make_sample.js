// Builds samples/invoice_edited.pdf  (Node, no dependencies:  node samples/make_sample.js)
//
// The file is written BY HAND in two revisions, exactly the way an "incremental save" works:
//   revision 1: an invoice for GHS 1,000.00, Info: Producer "Generic Report Writer"
//   revision 2: appended after revision 1's %%EOF. Replaces the content stream so the invoice
//               reads GHS 10,000.00, and replaces the Info dictionary with a different Producer.
// Any viewer shows only the new amount. Quanttum PDF's Inspector shows both versions.
// All names, numbers and amounts are fictional.

const fs = require('fs');
const path = require('path');

function stream(text) {
  return `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`;
}
function content(amount) {
  return [
    'BT /F1 22 Tf 72 740 Td (INVOICE No. 2026-0417) Tj ET',
    'BT /F1 12 Tf 72 700 Td (Prepared for: Ama Mensah Stores, Kumasi) Tj ET',
    'BT /F1 12 Tf 72 676 Td (Account no: 0123456789) Tj ET',
    'BT /F1 12 Tf 72 652 Td (Services rendered: stock audit, March 2026) Tj ET',
    `BT /F1 16 Tf 72 600 Td (Amount due: ${amount}) Tj ET`
  ].join('\n');
}

let buf = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const offsets = {};
function addObj(num, body) {
  offsets[num] = buf.length;
  buf = Buffer.concat([buf, Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1')]);
}
function xrefEntry(off) { return String(off).padStart(10, '0') + ' 00000 n \n'; }

// ---- revision 1 ----
addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
addObj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
addObj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
addObj(4, stream(content('GHS 1,000.00')));
addObj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
addObj(6, '<< /Producer (Generic Report Writer) /Creator (Generic Report Writer) /CreationDate (D:20260302091500+00\'00\') /ModDate (D:20260302091500+00\'00\') >>');

const xref1 = buf.length;
let x = 'xref\n0 7\n0000000000 65535 f \n';
for (let n = 1; n <= 6; n++) x += xrefEntry(offsets[n]);
x += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref1}\n%%EOF\n`;
buf = Buffer.concat([buf, Buffer.from(x, 'latin1')]);

// ---- revision 2 (incremental update) ----
addObj(4, stream(content('GHS 10,000.00')));
addObj(6, '<< /Producer (Generic PDF Editor) /Creator (Generic Report Writer) /CreationDate (D:20260302091500+00\'00\') /ModDate (D:20260314163042+00\'00\') >>');

const xref2 = buf.length;
let y = 'xref\n0 1\n0000000000 65535 f \n4 1\n' + xrefEntry(offsets[4]) + '6 1\n' + xrefEntry(offsets[6]);
y += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev ${xref1} >>\nstartxref\n${xref2}\n%%EOF\n`;
buf = Buffer.concat([buf, Buffer.from(y, 'latin1')]);

const outFile = path.join(__dirname, 'invoice_edited.pdf');
fs.writeFileSync(outFile, buf);
console.log('wrote', outFile, buf.length, 'bytes');
