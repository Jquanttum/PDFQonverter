"""Phone-size checks (Pixel 7 emulation): no sideways scrolling, usable navigation, touch scrolling over a page."""
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
def overflow(page):
    return page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    dev = dict(p.devices['Pixel 7'])
    ctx = b.new_context(**dev, accept_downloads=True)
    page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8765/index.html')
    ok(overflow(page) <= 0, 'start screen does not scroll sideways')
    page.screenshot(path=SP + 'm-start.png')
    ok(page.locator('#btnOpen2').is_visible() and page.locator('#btnOpen2').bounding_box()['height'] >= 40, 'Open button visible and finger-sized')
    page.set_input_files('#fileOpen', ROOT + 'samples/invoice_edited.pdf')
    page.wait_for_selector('#pages .page canvas.pdf', timeout=20000)
    ok(overflow(page) <= 0, 'document view does not scroll sideways')
    ok(page.locator('#mNav').is_visible(), 'bottom navigation is shown on a phone')
    ok(not page.locator('#panel').is_visible() and not page.locator('#thumbs').is_visible(), 'side panels are hidden until chosen')
    ok(page.evaluate("[...document.querySelectorAll('#tools .tool .ico')].every(e=>e.getBoundingClientRect().width>10)"), 'every tool icon is visible (labels hidden, icons kept)')
    box = page.locator('#pages .page').first.bounding_box(); vw = page.viewport_size['width']
    ok(box['width'] <= vw, 'page fits the screen width (%d <= %d)' % (box['width'], vw))
    page.screenshot(path=SP + 'm-doc.png')
    page.click('#mNav [data-m=pages]'); page.wait_for_timeout(300)
    ok(page.locator('#thumbs').is_visible() and overflow(page) <= 0, 'Pages panel opens full screen')
    page.click('#mNav [data-m=inspect]'); page.wait_for_selector('#rptGo', timeout=15000)
    ok(page.locator('#panel').is_visible() and overflow(page) <= 0, 'Inspect panel opens and fits')
    page.screenshot(path=SP + 'm-inspect.png')
    page.click('#mNav [data-m=edit]'); page.wait_for_timeout(300)
    ok(page.locator('#paneEdit').is_visible(), 'Edit panel opens')
    page.click('#mNav [data-m=view]'); page.wait_for_timeout(300)
    ok(page.locator('#viewer').is_visible() and not page.locator('#panel').is_visible(), 'back to the document')
    ov = page.evaluate("getComputedStyle(document.querySelector('.page svg.overlay')).touchAction")
    ok('pan-y' in ov, 'touch-action lets a finger scroll the page with the Select tool (' + ov + ')')
    page.click('.seg-btn[data-mode=convert]'); page.wait_for_selector('#cvNav .cv-item', timeout=5000)
    ok(overflow(page) <= 0 and page.locator('#cvMain').is_visible(), 'Convert mode fits, conversions listed as a swipeable strip')
    page.screenshot(path=SP + 'm-convert.png')
    page.click('#cvNav .cv-item >> nth=9'); page.wait_for_timeout(400)
    ok(overflow(page) <= 0, 'Office inspector screen fits')
    ok(not errors, 'no page errors ' + str(errors[:2]))
    b.close()
import sys; sys.exit(1 if fails else 0)
