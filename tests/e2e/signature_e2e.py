"""Inspect tab: Digital signatures card, tamper detection and the case report section."""
import os, pathlib, tempfile
from playwright.sync_api import sync_playwright
ROOT = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

def card(page, name):
    page.set_input_files('#fileOpen', ROOT + 'tests/fixtures/' + name)
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    page.click('.tab[data-tab=inspect]')
    page.wait_for_function("QPDF.state.analysis && QPDF.state.analysis.name === '" + name + "' && QPDF.state.analysis.sigs", timeout=15000)
    page.wait_for_selector('#rptGo:not([disabled])', timeout=15000)
    return page.locator('#sigCard')

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8765/index.html')

    c = card(page, 'signed_ok.pdf'); t = c.inner_text()
    ok(c.count() == 1 and 'Ama Mensah (test)' in t, 'intact: card names the signer')
    ok('matches (SHA-256)' in t and 'valid against the certificate key' in t, 'intact: hash and signature maths pass')
    ok('whole file' in t and 'Not checked: whether any certificate is trusted' in t, 'intact: coverage and the honest limit are shown')
    page.screenshot(path=SP + 'sig-ok.png')
    with page.expect_download(timeout=60000) as dl: page.click('#rptGo')
    dl.value.save_as(SP + 'sig-report.html'); h = open(SP + 'sig-report.html', encoding='utf-8').read()
    ok('Digital signatures' in h and 'Ama Mensah (test)' in h and '<script' not in h, 'case report has a signatures section, no scripts')

    t = card(page, 'signed_tampered.pdf').inner_text()
    ok('MISMATCH' in t and 'CHANGED' in t, 'tampered: shows the covered bytes changed')
    page.screenshot(path=SP + 'sig-tampered.png')

    t = card(page, 'signed_appended.pdf').inner_text()
    ok('NOT covered' in t and '652 bytes' in t, 'appended: shows bytes after the signature are not covered')

    t = card(page, 'signed_twice.pdf').inner_text()
    ok('Kofi Boateng (test)' in t and 'covered by signature 2' in t, 'two signatures: both listed, countersigning explained')

    page.set_input_files('#fileOpen', ROOT + 'samples/invoice_edited.pdf')
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    page.click('.tab[data-tab=inspect]')
    page.wait_for_function("QPDF.state.analysis && QPDF.state.analysis.name === 'invoice_edited.pdf' && QPDF.state.analysis.sigs", timeout=15000)
    ok(page.locator('#sigCard').count() == 0, 'unsigned file: no signatures card')
    ok(not errors, 'no console errors ' + str(errors[:2]))
    b.close()
import sys; sys.exit(1 if fails else 0)
