"""Builds the Office fixtures used by tests/office.test.js.   python3 make_office_fixtures.py

Needs: python-docx and openpyxl (they are the independent readers that provide the expected values), plus the
existing book.xlsx / sample.docx fixtures. All names, paths and text are fictional.

  evidence.docx   hand-built: tracked changes by two people, a comment, hidden text, a template path on a user's
                  computer, a custom property with a sensitivity label, an unreferenced part, Created after
                  Modified, and zip entries dated months after the claimed modification date
  trailing.docx   evidence.docx with bytes appended after the end of the zip
  dupe.docx       two entries with the same name (readers disagree about which one counts)
  reordered.docx  claims to be written by Microsoft Word but [Content_Types].xml is not first
  macro.xlsm      book.xlsx plus a VBA project
  leftover.xlsx   book.xlsx with two extra shared strings that no cell uses (as after a cell was deleted)
  hidden.pptx     a hand-built deck with a hidden slide, speaker notes and a comment author
  office_expected.json   values read by python-docx / openpyxl, to compare with what office.js reads
"""
import datetime, io, json, os, shutil, zipfile

import docx
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'


def rels(items):
    body = ''.join('<Relationship Id="%s" Type="%s" Target="%s"%s/>' % (i, t if t.startswith('http') else REL + t, tgt, ' TargetMode="External"' if ext else '') for i, t, tgt, ext in items)
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">%s</Relationships>' % (PKG, body)


def write_zip(path, parts, date=(2026, 6, 10, 9, 30, 0), order=None):
    names = order or list(parts)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=date)
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, parts[n])


def evidence_parts():
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Default Extension="txt" ContentType="text/plain"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
          '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
          '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>')
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>'
           '<w:p><w:r><w:t>Supply agreement between the two parties.</w:t></w:r></w:p>'
           '<w:p><w:r><w:t xml:space="preserve">The price is </w:t></w:r>'
           '<w:del w:id="1" w:author="Kofi Boateng" w:date="2026-03-05T10:30:00Z"><w:r><w:delText>GHS 48,000</w:delText></w:r></w:del>'
           '<w:ins w:id="2" w:author="Ama Owusu" w:date="2026-03-01T09:00:00Z"><w:r><w:t>GHS 52,000</w:t></w:r></w:ins>'
           '<w:r><w:t xml:space="preserve"> per year.</w:t></w:r></w:p>'
           '<w:p><w:ins w:id="3" w:author="Kofi Boateng" w:date="2026-03-06T14:15:00Z"><w:r><w:t>Payment within 14 days.</w:t></w:r></w:ins></w:p>'
           '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Delivery is quarterly.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>'
           '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Internal: walk-away price is GHS 45,000</w:t></w:r></w:p>'
           '<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author="Ama Owusu" w:date="2026-03-02T08:10:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Bold after a change.</w:t></w:r></w:p>'
           '<w:p><w:hyperlink r:id="rIdH"><w:r><w:t>terms</w:t></w:r></w:hyperlink></w:p>'
           '</w:body></w:document>') % NS_W
    comments = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments %s>'
                '<w:comment w:id="0" w:author="Ama Owusu" w:date="2026-03-02T08:00:00Z" w:initials="AO"><w:p><w:r><w:t>Confirm quarterly with the supplier.</w:t></w:r></w:p></w:comment></w:comments>') % NS_W
    settings = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings %s><w:rsids><w:rsidRoot w:val="00AA0001"/>'
                '<w:rsid w:val="00AA0001"/><w:rsid w:val="00BB0002"/><w:rsid w:val="00CC0003"/></w:rsids>'
                '<w:attachedTemplate r:id="rIdT"/></w:settings>') % NS_W
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            '<dc:title>Supply agreement</dc:title><dc:creator>Ama Owusu</dc:creator><cp:lastModifiedBy>Kofi Boateng</cp:lastModifiedBy><cp:revision>7</cp:revision>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-03-10T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-03-02T16:45:00Z</dcterms:modified></cp:coreProperties>')
    app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
           '<Template>Normal.dotm</Template><TotalTime>95</TotalTime><Pages>1</Pages><Words>40</Words><Application>Microsoft Office Word</Application>'
           '<Company>Northern Traders Ltd</Company><AppVersion>16.0000</AppVersion></Properties>')
    custom = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
              'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
              '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MSIP_Label_1234_Name"><vt:lpwstr>Confidential</vt:lpwstr></property>'
              '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="ClientCode"><vt:lpwstr>NT-0042</vt:lpwstr></property></Properties>')
    return {
        '[Content_Types].xml': ct,
        '_rels/.rels': rels([('r1', 'officeDocument', 'word/document.xml', 0), ('r2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml', 0),
                             ('r3', 'extended-properties', 'docProps/app.xml', 0), ('r4', 'custom-properties', 'docProps/custom.xml', 0),
                             ('r5', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail', 'docProps/thumbnail.jpeg', 0)]),
        'docProps/core.xml': core, 'docProps/app.xml': app, 'docProps/custom.xml': custom,
        'docProps/thumbnail.jpeg': open(os.path.join(HERE, 'plain.jpg'), 'rb').read(),
        'word/document.xml': doc,
        'word/_rels/document.xml.rels': rels([('rIdS', 'settings', 'settings.xml', 0), ('rIdC', 'comments', 'comments.xml', 0), ('rIdH', 'hyperlink', 'https://example.org/terms', 1)]),
        'word/settings.xml': settings,
        'word/_rels/settings.xml.rels': rels([('rIdT', 'attachedTemplate', 'file:///C:\\Users\\kofi.boateng\\AppData\\Roaming\\Templates\\Normal.dotm', 1)]),
        'word/comments.xml': comments,
        'word/secret.txt': 'Notes that nothing in the document points to.',
    }


def eocd_end(data):
    i = data.rfind(b'PK\x05\x06')
    return i + 22 + int.from_bytes(data[i + 20:i + 22], 'little')


# ---------------------------------------------------------------- docx variants
parts = evidence_parts()
write_zip(os.path.join(HERE, 'evidence.docx'), parts)
ev = open(os.path.join(HERE, 'evidence.docx'), 'rb').read()
open(os.path.join(HERE, 'trailing.docx'), 'wb').write(ev + b'TRAILING-SECRET-DATA')

with zipfile.ZipFile(os.path.join(HERE, 'dupe.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    for n, v in parts.items():
        z.writestr(zipfile.ZipInfo(n, date_time=(2026, 6, 10, 9, 30, 0)), v)
    z.writestr(zipfile.ZipInfo('word/document.xml', date_time=(2026, 6, 10, 9, 30, 0)), parts['word/document.xml'].replace('Supply agreement', 'DIFFERENT TEXT'))

order = [n for n in parts if n != '[Content_Types].xml'] + ['[Content_Types].xml']
write_zip(os.path.join(HERE, 'reordered.docx'), parts, order=order)

# ---------------------------------------------------------------- xlsx variants
with zipfile.ZipFile(os.path.join(HERE, 'book.xlsx')) as zin, zipfile.ZipFile(os.path.join(HERE, 'macro.xlsm'), 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename))
    zout.writestr('xl/vbaProject.bin', b'\xd0\xcf\x11\xe0 fake vba project for tests')

with zipfile.ZipFile(os.path.join(HERE, 'book.xlsx')) as zin, zipfile.ZipFile(os.path.join(HERE, 'leftover.xlsx'), 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == 'xl/sharedStrings.xml':
            s = data.decode('utf-8')
            s = s.replace('</sst>', '<si><t>Old balance 91,250.00 (cell deleted)</t></si><si><t>Draft note: ask Yaw about the missing receipt</t></si></sst>')
            data = s.encode('utf-8')
        zout.writestr(item, data)

# ---------------------------------------------------------------- pptx
P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'


def slide(text, hidden=False):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld %s%s><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
            % (P, ' show="0"' if hidden else '', text))


pp = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': rels([('r1', 'officeDocument', 'ppt/presentation.xml', 0), ('r2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml', 0)]),
    'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Board pack</dc:title><dc:creator>Esi Darko</dc:creator><cp:lastModifiedBy>Esi Darko</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-02-01T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-03T08:00:00Z</dcterms:modified></cp:coreProperties>',
    'ppt/presentation.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation %s><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>' % P,
    'ppt/_rels/presentation.xml.rels': rels([('rId1', 'slide', 'slides/slide1.xml', 0), ('rId2', 'slide', 'slides/slide2.xml', 0), ('rId3', 'slide', 'slides/slide3.xml', 0), ('rId4', 'commentAuthors', 'commentAuthors.xml', 0)]),
    'ppt/slides/slide1.xml': slide('Quarterly results'),
    'ppt/slides/slide2.xml': slide('Layoff plan: 14 roles', hidden=True),
    'ppt/slides/slide3.xml': slide('Next steps'),
    'ppt/slides/_rels/slide3.xml.rels': rels([('rId1', 'notesSlide', '../notesSlides/notesSlide3.xml', 0), ('rId2', 'comments', '../comments/comment1.xml', 0)]),
    'ppt/notesSlides/notesSlide3.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes %s><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Do not mention the supplier dispute unless asked.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>' % P,
    'ppt/commentAuthors.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst %s><p:cmAuthor id="0" name="Yaw Mensah" initials="YM" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>' % P,
    'ppt/comments/comment1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmLst %s><p:cm authorId="0" dt="2026-02-02T10:00:00.000" idx="1"><p:text>Check the date</p:text></p:cm></p:cmLst>' % P,
}
write_zip(os.path.join(HERE, 'hidden.pptx'), pp, date=(2026, 2, 3, 8, 0, 0))

# ---------------------------------------------------------------- independent expectations
exp = {}
d = docx.Document(os.path.join(HERE, 'evidence.docx')).core_properties
exp['evidence.docx'] = {'title': d.title, 'creator': d.author, 'lastModifiedBy': d.last_modified_by, 'revision': d.revision,
                        'created': d.created.strftime('%Y-%m-%dT%H:%M:%SZ'), 'modified': d.modified.strftime('%Y-%m-%dT%H:%M:%SZ')}
d = docx.Document(os.path.join(HERE, 'sample.docx')).core_properties
exp['sample.docx'] = {'creator': d.author, 'revision': d.revision, 'created': d.created.strftime('%Y-%m-%dT%H:%M:%SZ')}
w = openpyxl.load_workbook(os.path.join(HERE, 'book.xlsx'))
exp['book.xlsx'] = {
    'creator': w.properties.creator, 'sheets': {s.title: s.sheet_state for s in w.worksheets},
    'hiddenRows': {s.title: sorted(r for r, dim in s.row_dimensions.items() if dim.hidden) for s in w.worksheets},
    'hiddenCols': {s.title: sorted(c for c, dim in s.column_dimensions.items() if dim.hidden) for s in w.worksheets},
    'comments': {s.title: sum(1 for row in s.iter_rows() for c in row if c.comment) for s in w.worksheets},
}
json.dump(exp, open(os.path.join(HERE, 'office_expected.json'), 'w'), indent=1)
print('ok', exp['evidence.docx'], exp['book.xlsx']['sheets'], exp['book.xlsx']['hiddenRows'], exp['book.xlsx']['hiddenCols'])
