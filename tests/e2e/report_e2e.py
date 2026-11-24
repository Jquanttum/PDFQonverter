import sys, re, hashlib
from playwright.sync_api import sync_playwright

import os, pathlib, tempfile
ROOT_DIR = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'   # screenshots and downloads land here
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']       # optional: use an installed Chrome
ROOT = ROOT_DIR + ''
SAMPLE = ROOT + 'samples/invoice_edited.pdf'
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8765/index.html')
    page.set_input_files('#fileOpen', SAMPLE)
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    page.click('.tab[data-tab=inspect]')
    page.wait_for_selector('#rptGo:not([disabled])', timeout=15000)
    ok(page.locator('#rptGo').count() == 1, 'Export case report button on the Inspect tab (enabled once the hash exists)')
    page.fill('#rptCase', 'UDS/FS/2026/014 <b>')
    page.fill('#rptExaminer', 'J. Dela')
    page.wait_for_function("Array.isArray(QPDF.state.revDetails)", timeout=20000)

    def export(name):
        with page.expect_download(timeout=60000) as dl:
            page.click('#rptGo')
        d = dl.value
        ok(d.suggested_filename.endswith('case report.html'), 'download name: ' + d.suggested_filename)
        pth = SP + name
        d.save_as(pth)
        return open(pth, encoding='utf-8').read()

    html = export('report1.html')
    want = hashlib.sha256(open(SAMPLE, 'rb').read()).hexdigest()
    ok(want in html, 'report contains the real SHA-256 of the opened file (computed independently)')
    ok('UDS/FS/2026/014 &lt;b&gt;' in html and '<b> ' not in html.split('Case reference')[1][:120], 'case reference escaped')
    ok('J. Dela' in html, 'examiner printed')
    ok('The file holds <b>2</b> saved versions' in html, 'two revisions reported')
    ok('producer changed' in html, 'producer change flagged')
    # independent check of the revision hashes: first revision = bytes up to the first %%EOF
    raw = open(SAMPLE, 'rb').read()
    ends = [m.end() for m in re.finditer(rb'startxref\s+\d+\s*%%EOF\r?\n?', raw)]
    ok(len(ends) == 2, 'independent scan also finds 2 revisions')
    for i, e in enumerate(ends, 1):
        ok(hashlib.sha256(raw[:e]).hexdigest() in html, 'revision %d hash matches an independently computed prefix hash' % i)
    ok('Opened for examination' in html, 'log: open recorded')
    ok('Case report exported' not in html, 'the export itself is logged after, not inside, the report that was just made')
    ok('http://' not in re.sub(r'<style>.*?</style>', '', html, flags=re.S).replace('http://www.w3.org', ''), 'no external links')

    # a save and a conversion, then a second report
    page.click('.tab[data-tab=edit]')
    page.click('[data-act=blank]')
    page.click('#btnSave'); page.wait_for_selector('#saveDlg[open]')
    with page.expect_download(timeout=30000):
        page.click('#saveGo')
    page.wait_for_selector('#saveResult:not([hidden])')
    page.keyboard.press('Escape')
    page.click('.seg-btn[data-mode=convert]')
    page.click('.cv-item[data-task=pdf2txt]')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files(ROOT + 'tests/fixtures/table.pdf')
    page.wait_for_selector('#cvRmSrc')
    page.click('#cvGo'); page.wait_for_selector('#cvResult .result.ok', timeout=30000)
    page.click('.seg-btn[data-mode=edit]')
    page.click('.tab[data-tab=inspect]')
    page.wait_for_selector('#rptGo')
    html2 = export('report2.html')
    ok('Saved as a new PDF' in html2, 'log: save recorded')
    ok('Converted' in html2 or 'PDF to text' in html2, 'log: conversion recorded')
    ok('Case report exported' in html2, 'log: the first export is recorded in the second report')
    tab = hashlib.sha256(open(ROOT + 'tests/fixtures/table.pdf', 'rb').read()).hexdigest()
    ok(tab in html2, 'conversion source hash (independent) is in the log')
    ok(html2.count(want) >= 2, 'the examined file hash appears in the item section and as the source of the save')
    ok(page.locator('#rptCase').input_value() == 'UDS/FS/2026/014 <b>', 'case reference survives re-render')
    page.screenshot(path=SP + 'r1_inspect.png')
    pg2 = ctx.new_page(); pg2.goto('file://' + SP + 'report2.html')
    pg2.set_viewport_size({'width': 900, 'height': 1200})
    pg2.screenshot(path=SP + 'r2_report.png', full_page=True)
    pg2.pdf(path=SP + 'report2_print.pdf', format='A4')
    ok(not errors, 'no JavaScript errors: %s' % errors[:3])
    b.close()
print('\n%d failure(s)' % len(fails))
sys.exit(1 if fails else 0)
