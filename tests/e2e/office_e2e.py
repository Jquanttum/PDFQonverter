import sys, re, io, zipfile, hashlib
from playwright.sync_api import sync_playwright

import os, pathlib, tempfile
ROOT_DIR = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'   # screenshots and downloads land here
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']       # optional: use an installed Chrome
ROOT = ROOT_DIR + ''
FX = ROOT + 'tests/fixtures/'
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)
sha = lambda b: hashlib.sha256(b).hexdigest()

# a hostile copy of evidence.docx: author, comment, hidden text and a deleted text full of markup
src = zipfile.ZipFile(FX + 'evidence.docx')
HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'
esc = HOSTILE.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for n in src.namelist():
        d = src.read(n)
        if n == 'docProps/core.xml': d = d.replace(b'Ama Owusu', esc.encode())
        if n == 'word/document.xml': d = d.replace(b'walk-away price is GHS 45,000', esc.encode()).replace(b'GHS 48,000', esc.encode())
        z.writestr(n, d)
open(SP + 'hostile.docx', 'wb').write(buf.getvalue())
open(SP + 'legacy.doc', 'wb').write(bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b'\0' * 600)

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 1000}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    dialogs = []
    page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    page.goto('http://127.0.0.1:8765/index.html')
    page.click('.seg-btn[data-mode=convert]')
    page.wait_for_selector('#cvNav .cv-item')
    ok(page.locator('#cvNav .cv-item').count() == 11, 'eleven items in the nav')
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    ok(page.locator('.cv-opts').count() == 0, 'no empty Options card for the inspector')
    ok(page.locator('#cvGo').is_disabled(), 'Inspect disabled before a file is chosen')

    def load(path):
        with page.expect_file_chooser() as fc:
            page.click('#cvBrowse')
        fc.value.set_files(path)

    def inspect(path):
        load(path)
        page.wait_for_selector('#cvRmSrc')
        page.click('#cvGo')
        page.wait_for_selector('#cvResult .result.ok, #cvResult .result.bad', timeout=30000)
        return page.inner_text('#cvResult')

    # refusals
    load(SP + 'legacy.doc'); page.wait_for_timeout(500)
    ok(page.locator('#cvRmSrc').count() == 0, 'a legacy .doc is refused at load')
    load(FX + 'table.pdf'); page.wait_for_timeout(500)
    ok(page.locator('#cvRmSrc').count() == 0, 'a PDF is refused')

    # evidence.docx
    txt = inspect(FX + 'evidence.docx')
    page.screenshot(path=SP + 'o1_inspect.png', full_page=False)
    ev = open(FX + 'evidence.docx', 'rb').read()
    ok(sha(ev) in txt, 'SHA-256 shown matches an independent hash')
    ok('Word document' in txt and 'points to check' in txt, 'summary line')
    for needle in ['4 tracked changes', 'GHS 48,000', 'walk-away price is GHS 45,000', 'Confirm quarterly with the supplier', 'kofi.boateng', 'word/secret.txt',
                   'before it was created', 'Northern Traders Ltd', 'ClientCode', 'NT-0042', 'Ama Owusu', 'Kofi Boateng']:
        ok(needle in txt, 'shown: ' + needle)
    ok(page.locator('#cvResult .finding.warn').count() >= 6, 'warnings rendered (%d)' % page.locator('#cvResult .finding.warn').count())
    ok(page.locator('#cvResult table.cv-table').count() >= 2, 'tables rendered')
    page.screenshot(path=SP + 'o2_inspect_full.png', full_page=True)

    page.fill('#cvCase', 'UDS/FS/2026/021'); page.fill('#cvExaminer', 'J. Dela')
    with page.expect_download(timeout=30000) as dl:
        page.click('#cvRptGo')
    dl.value.save_as(SP + 'office_report.html')
    rp = open(SP + 'office_report.html', encoding='utf-8').read()
    ok(dl.value.suggested_filename == 'evidence - case report.html', 'report file name: ' + dl.value.suggested_filename)
    for needle in [sha(ev), 'UDS/FS/2026/021', 'J. Dela', 'Office file examination record', 'Deleted text still in the file', 'GHS 48,000', 'Tracked changes', 'Comments', 'Inspected word document', 'Examiner signature']:
        ok(needle in rp, 'report has: ' + needle)
    ok('<script' not in rp.lower() and 'http://' not in re.sub(r'<style>.*?</style>', '', rp, flags=re.S).replace('http://www.w3.org', ''), 'report: no scripts, no external links')

    # trailing data, with an independent hash of the trailing bytes
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    tr = open(FX + 'trailing.docx', 'rb').read()
    txt = inspect(FX + 'trailing.docx')
    ok('20 bytes follow the end of the zip container' in txt, 'trailing bytes finding in the UI')
    with page.expect_download(timeout=30000) as dl:
        page.click('#cvRptGo')
    dl.value.save_as(SP + 'office_report2.html')
    rp2 = open(SP + 'office_report2.html', encoding='utf-8').read()
    ok(sha(b'TRAILING-SECRET-DATA') in rp2 and 'Data after the end of the zip container' in rp2, 'report records the hash of the data after the zip (independently computed)')
    ok(sha(tr) in rp2 and 'Inspected word document' in rp2 and rp2.count('Case report exported') == 1, 'second report logs both inspections and the first export')

    # hostile content must stay text
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    txt = inspect(SP + 'hostile.docx')
    ok(page.evaluate('window.__pwned') is None and not dialogs, 'hostile file ran no script on the page')
    ok(page.locator('#cvResult img').count() == 0 and page.locator('#cvResult script').count() == 0, 'no injected elements in the results')
    ok('<img src=x' in txt, 'the markup is displayed as text')
    with page.expect_download(timeout=30000) as dl:
        page.click('#cvRptGo')
    dl.value.save_as(SP + 'office_report3.html')
    rp3 = open(SP + 'office_report3.html', encoding='utf-8').read()
    ok('<img src=x' not in rp3 and '&lt;img src=x' in rp3, 'report escapes the same content')
    pg2 = ctx.new_page(); pg2.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
    pg2.goto('file://' + SP + 'office_report3.html'); pg2.wait_for_timeout(400)
    ok(pg2.evaluate('window.__pwned') is None and pg2.locator('img').count() == 0, 'opening the hostile report runs nothing')
    pg2.close()

    # xlsx and pptx
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    txt = inspect(FX + 'macro.xlsm')
    ok('Excel workbook' in txt and 'macro project' in txt and 'hidden' in txt and 'Payroll' in txt, 'xlsm: macros and hidden sheet reported')
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    txt = inspect(FX + 'leftover.xlsx')
    ok('Old balance 91,250.00' in txt and 'missing receipt' in txt, 'xlsx: leftover strings shown')
    page.click('.cv-item[data-task=inspect]'); page.wait_for_selector('#cvGo')
    txt = inspect(FX + 'hidden.pptx')
    ok('Layoff plan: 14 roles' in txt and 'supplier dispute' in txt and 'Yaw Mensah' in txt, 'pptx: hidden slide, speaker notes and comment author')
    page.screenshot(path=SP + 'o3_pptx.png', full_page=True)

    # the editor report picks up the shared log
    page.click('.seg-btn[data-mode=edit]')
    page.set_input_files('#fileOpen', ROOT + 'samples/invoice_edited.pdf')
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    page.click('.tab[data-tab=inspect]'); page.wait_for_selector('#rptGo:not([disabled])', timeout=15000)
    page.wait_for_function("Array.isArray(QPDF.state.revDetails)", timeout=20000)
    with page.expect_download(timeout=60000) as dl:
        page.click('#rptGo')
    dl.value.save_as(SP + 'pdf_report_shared.html')
    rp4 = open(SP + 'pdf_report_shared.html', encoding='utf-8').read()
    ok('Inspected word document' in rp4 and 'Inspected excel workbook' in rp4 and 'Inspected powerpoint presentation' in rp4, 'the PDF case report also lists the Office inspections from this session')
    ok(not errors, 'no JavaScript errors: %s' % errors[:3])
    b.close()
print('\n%d failure(s)' % len(fails))
sys.exit(1 if fails else 0)
