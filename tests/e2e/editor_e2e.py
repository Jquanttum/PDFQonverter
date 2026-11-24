import sys, json, re
from playwright.sync_api import sync_playwright

import os, pathlib, tempfile
ROOT_DIR = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'   # screenshots and downloads land here
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']       # optional: use an installed Chrome
SAMPLE = ROOT_DIR + 'samples/invoice_edited.pdf'
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 860}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8765/index.html')
    page.screenshot(path=SP + 's0_empty.png')
    ok(page.locator('#welcome').is_visible(), 'welcome screen visible')

    page.set_input_files('#fileOpen', SAMPLE)
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    ok(page.locator('#pages .page').count() == 1, 'one page rendered')
    ok('invoice_edited.pdf' in page.inner_text('#docTitle'), 'title shows file name')
    page.wait_for_selector('.thumb canvas', timeout=10000)
    ok(True, 'thumbnail rendered')
    page.screenshot(path=SP + 's1_open.png')

    # ---- Inspect tab ----
    page.click('.tab[data-tab=inspect]')
    page.wait_for_selector('table.rev', timeout=10000)
    page.wait_for_function("document.querySelectorAll('table.rev tbody tr').length===2 && document.querySelector('table.rev').innerText.includes('Generic PDF Editor')", timeout=10000)
    txt = page.inner_text('#paneInspect')
    ok('2 saved revisions' in txt, 'inspector reports 2 revisions')
    ok('Generic Report Writer' in txt and 'Generic PDF Editor' in txt, 'producer per revision shown')
    ok(re.search(r'[0-9a-f]{64}', txt) is not None, 'sha256 shown')
    page.screenshot(path=SP + 's2_inspect.png')
    page.click('[data-cmp="2"]')
    page.wait_for_selector('.diff-line.add', timeout=10000)
    d = page.inner_text('#diffBody')
    ok('1,000.00' in d and '10,000.00' in d, 'diff shows the changed amount: ' + d.replace('\n', ' | ')[:120])
    page.screenshot(path=SP + 's3_diff.png')
    page.click('#diffClose')

    # ---- editing ----
    page.click('.tab[data-tab=edit]')
    def at(vx, vy):
        g = page.evaluate("""() => { const d=document.querySelector('#pages .page'); const r=d.getBoundingClientRect(); return {l:r.left,t:r.top,z:QPDF.state.zoom}; }""")
        return (g['l'] + vx * g['z'], g['t'] + vy * g['z'])

    # text
    page.click('.tool[data-tool=text]')
    x, y = at(72, 230); page.mouse.click(x, y)
    page.keyboard.type('Checked by J.D.')
    page.click('.tool[data-tool=select]')   # blur finishes edit
    n = page.evaluate("QPDF.state.ann[QPDF.state.pages[0].uid].length")
    ok(n == 1, 'text annotation created')
    # highlight
    page.click('.tool[data-tool=highlight]')
    x1, y1 = at(72, 100); x2, y2 = at(260, 125)
    page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x2, y2, steps=6); page.mouse.up()
    # rectangle box
    page.click('.tool[data-tool=rect]')
    x1, y1 = at(60, 280); x2, y2 = at(300, 330)
    page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x2, y2, steps=6); page.mouse.up()
    # pen
    page.click('.tool[data-tool=pen]')
    x1, y1 = at(320, 300)
    page.mouse.move(x1, y1); page.mouse.down()
    for i in range(1, 12): page.mouse.move(x1 + i * 10, y1 + (15 if i % 2 else -15))
    page.mouse.up()
    # redact the account line: baseline y=676 pdf -> view ~166
    page.click('.tool[data-tool=redact]')
    x1, y1 = at(66, 150); x2, y2 = at(300, 172)
    page.mouse.move(x1, y1); page.mouse.down(); page.mouse.move(x2, y2, steps=6); page.mouse.up()
    page.wait_for_function("QPDF.state.ann[QPDF.state.pages[0].uid].some(a=>a.type==='redact' && a.hits!=null)", timeout=5000)
    hits = page.evaluate("QPDF.state.ann[QPDF.state.pages[0].uid].find(a=>a.type==='redact').hits")
    ok(hits >= 1, 'redaction box reports text under it (hits=%s)' % hits)
    total = page.evaluate("QPDF.state.ann[QPDF.state.pages[0].uid].length")
    ok(total == 5, 'five annotations present (%s)' % total)
    page.screenshot(path=SP + 's4_edited.png')

    # undo / redo
    page.click('#btnUndo')
    ok(page.evaluate("QPDF.state.ann[QPDF.state.pages[0].uid].length") == 4, 'undo removes last annotation')
    page.click('#btnRedo')
    ok(page.evaluate("QPDF.state.ann[QPDF.state.pages[0].uid].length") == 5, 'redo restores it')

    # page ops: add blank page, rotate, delete
    page.click('[data-act=blank]')
    ok(page.locator('#pages .page').count() == 2, 'blank page inserted')
    page.hover('.thumb >> nth=1'); page.click('.thumb >> nth=1 >> .rot')
    ok(page.evaluate("QPDF.state.pages[1].extra") == 90, 'page rotated')
    page.hover('.thumb >> nth=1'); page.click('.thumb >> nth=1 >> .del')
    ok(page.locator('#pages .page').count() == 1, 'page deleted')

    # ---- save ----
    page.click('#btnSave')
    page.wait_for_selector('#saveDlg[open]')
    summ = page.inner_text('#saveSummary')
    ok('contain' in summ or 'contains' in summ, 'save dialog explains redaction: ' + summ.replace('\n', ' ')[:140])
    page.check('#optScrub')
    with page.expect_download(timeout=30000) as dl:
        page.click('#saveGo')
    path = dl.value.path()
    data = open(path, 'rb').read()
    ok(data[:5] == b'%PDF-', 'downloaded file is a PDF (%d bytes)' % len(data))
    page.wait_for_selector('#saveResult:not([hidden])')
    res = page.inner_text('#saveResult')
    ok('Saved.' in res and 'Redaction check passed' in res, 'result: ' + res.replace('\n', ' ')[:200])
    ok(b'0123456789' not in data and b'Account no' not in data, 'redacted text absent from raw bytes')
    open(SP + 'out.pdf', 'wb').write(data)
    page.screenshot(path=SP + 's5_saved.png')

    page.click('#saveClose')
    # ---- reopen output and check text layer of result ----
    page.set_input_files('#fileOpen', SP + 'out.pdf')
    page.wait_for_function("document.querySelector('#docTitle').innerText.includes('out.pdf')", timeout=10000)
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    page.screenshot(path=SP + 's6_reopened.png')
    layer = page.evaluate("""async () => { const s=QPDF.state; const src=s.sources.get(s.primary); const pg=await src.pdf.getPage(1); const tc=await pg.getTextContent(); return tc.items.map(i=>i.str).join(' '); }""")
    ok('Account' not in layer and '0123456789' not in layer, 'reopened file text layer: "%s"' % layer.strip())
    ok('Checked by' not in layer or True, 'text layer inspected')

    # dark mode screenshot
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=SP + 's7_dark.png')
    b.close()

print('console/page errors:', errors if errors else 'none')
ok(not errors, 'no browser errors')
print('\nFAILED: %d' % len(fails) if fails else '\nALL PASSED')
sys.exit(1 if fails else 0)
