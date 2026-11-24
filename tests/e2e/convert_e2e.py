import sys, os, re, io, zipfile, subprocess, shutil
from playwright.sync_api import sync_playwright
from PIL import Image

import os, pathlib, tempfile
ROOT_DIR = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'   # screenshots and downloads land here
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']       # optional: use an installed Chrome
FX = ROOT_DIR + 'tests/fixtures/'
SAMPLE = ROOT_DIR + 'samples/invoice_edited.pdf'
OUT = SP + 'cv_out/'
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT)
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8765/index.html')

    def task(tid):
        page.click('.cv-item[data-task=%s]' % tid)
        page.wait_for_selector('#cvGo')

    def run_and_download(name):
        page.click('#cvGo')
        page.wait_for_selector('#cvResult .result.ok, #cvResult .result.bad', timeout=60000)
        if page.locator('#cvResult .result.bad').count():
            return None
        with page.expect_download(timeout=30000) as dl:
            page.click('#cvDl')
        path = OUT + name
        dl.value.save_as(path)
        return path

    page.click('.seg-btn[data-mode=convert]')
    page.wait_for_selector('#cvNav .cv-item')
    ok(page.locator('#convertView').is_visible(), 'Convert view opens')
    ok(page.locator('#cvNav .cv-item').count() == 11, 'eleven items listed')
    page.screenshot(path=SP + 'c0_convert.png')

    # ------------------------------------------------ images -> PDF
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([FX + 'photo_orient6_gps.jpg', FX + 'plain.jpg', FX + 'pixel.png'])
    page.wait_for_selector('.cv-file')
    ok(page.locator('.cv-file').count() == 3, 'three images listed')
    # reorder: move last up, then back down
    page.click('[data-up="2"]'); page.click('[data-down="1"]')
    names = page.locator('.cv-fname b').all_inner_texts()
    ok(names == ['photo_orient6_gps.jpg', 'plain.jpg', 'pixel.png'], 'reorder arrows work: %s' % names)
    page.screenshot(path=SP + 'c1_images.png')
    path = run_and_download('imgs.pdf')
    ok(path is not None, 'images -> PDF produced')
    info = sh('pdfinfo', path)
    ok(re.search(r'Pages:\s+3', info) is not None, 'PDF has 3 pages')
    raw = open(path, 'rb').read()
    ok(b'Exif' not in raw and b'GPS' not in raw and b'Canon' not in raw, 'no EXIF/GPS strings anywhere in the PDF bytes')
    res = page.inner_text('#cvResult')
    ok('GPS' in res or 'hidden data' in res, 'result explains what was removed')
    page.screenshot(path=SP + 'c2_images_done.png')
    # orientation: page 1 should match the UPRIGHT shape of the orient-6 photo (w/h swapped)
    im = Image.open(FX + 'photo_orient6_gps.jpg'); raw_w, raw_h = im.size
    pg1 = sh('pdfinfo', '-f', '1', '-l', '1', path)
    m = re.search(r'Page\s+1 size:\s+([\d.]+) x ([\d.]+)', pg1)
    pw, ph = float(m.group(1)), float(m.group(2))
    upright_portrait = raw_w > raw_h   # orientation 6 rotates 90deg, so a landscape raster becomes portrait
    ok((ph > pw) == upright_portrait, 'photo page is upright (page %.0fx%.0f, raster %dx%d)' % (pw, ph, raw_w, raw_h))
    scan_pdf = path

    # ------------------------------------------------ text -> PDF
    task('txt2pdf')
    ok(page.is_disabled('#cvGo'), 'Create PDF disabled while empty')
    body = '\n\n'.join('Paragraph %d. ' % i + 'The quick brown fox jumps over the lazy dog. ' * 18 for i in range(1, 16))
    body += '\n\nSymbols: café, naïve, 100% → done, 你好'
    page.fill('#cvText', body)
    ok(not page.is_disabled('#cvGo'), 'enabled once text is typed')
    path = run_and_download('text.pdf')
    ok(path is not None, 'text -> PDF produced')
    pages = int(re.search(r'Pages:\s+(\d+)', sh('pdfinfo', path)).group(1))
    ok(pages >= 2, 'long text flows over several pages (%d)' % pages)
    txt = sh('pdftotext', '-layout', path, '-')
    ok('Paragraph 1.' in txt and 'Paragraph 15.' in txt and 'café' in txt, 'first, last paragraph and accented text present')
    ok('?' in txt, 'unsupported CJK shown as ?')
    ok('character' in page.inner_text('#cvResult') and 'appear as ?' in page.inner_text('#cvResult'), 'result warns about replaced characters')
    multi_pdf = path

    # ------------------------------------------------ Word -> PDF
    task('doc2pdf')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([FX + 'sample.docx'])
    page.wait_for_selector('.cv-file')
    path = run_and_download('doc.pdf')
    ok(path is not None, 'docx -> PDF produced')
    txt = sh('pdftotext', '-layout', path, '-')
    # compare against what python-docx reads from the same file
    import docx
    d = docx.Document(FX + 'sample.docx')
    want = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    flat = re.sub(r'\s+', ' ', txt)
    missing = [w for w in want if re.sub(r'\s+', ' ', w)[:40] not in flat]
    ok(not missing, 'every paragraph of the .docx appears in the PDF (missing: %s)' % missing[:3])
    for t in d.tables:
        cells = [c.text.strip() for r in t.rows for c in r.cells if c.text.strip()]
        ok(all(c in flat for c in cells), 'table cells present in PDF (%d cells)' % len(cells))
    page.screenshot(path=SP + 'c3_doc.png')

    # ------------------------------------------------ PDF -> text
    task('pdf2txt')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([SAMPLE])
    page.wait_for_selector('.cv-file')
    path = run_and_download('invoice.txt')
    t = open(path, encoding='utf-8').read()
    ok('Amount due: GHS 10,000.00' in t and 'INVOICE No. 2026-0417' in t, 'invoice text extracted')
    ok('1,000.00' not in t.replace('10,000.00', ''), 'old revision amount is NOT in the extracted text')
    ok('Page 1' in t, 'page marker present')

    # bad range
    page.fill('#cvPages', '9-12')
    page.click('#cvGo'); page.wait_for_selector('#cvResult .result.bad')
    ok('outside this document' in page.inner_text('#cvResult'), 'bad page range gives a clear error')
    page.fill('#cvPages', '')

    # ------------------------------------------------ PDF -> text on a scan (image-only PDF)
    page.click('#cvRmSrc')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([scan_pdf])
    page.wait_for_selector('.cv-file')
    page.click('#cvGo'); page.wait_for_selector('#cvResult .result.bad', timeout=30000)
    ok('no selectable text' in page.inner_text('#cvResult'), 'scanned PDF gives the "no selectable text / OCR" message')

    # ------------------------------------------------ PDF -> Word
    task('pdf2doc')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([multi_pdf])
    page.wait_for_selector('.cv-file')
    path = run_and_download('multi.docx')
    ok(path is not None, 'PDF -> Word produced')
    d2 = docx.Document(path)
    body_txt = ' '.join(p.text for p in d2.paragraphs)
    ok('Paragraph 1.' in body_txt and 'Paragraph 15.' in body_txt, 'python-docx opens it and finds the text')
    # independent second opinion: LibreOffice converts the docx to PDF
    lo = subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', OUT + 'lo', path], capture_output=True, text=True, timeout=120)
    lo_pdf = OUT + 'lo/multi.pdf'
    ok(os.path.exists(lo_pdf), 'LibreOffice can open and render the generated .docx')
    if os.path.exists(lo_pdf):
        ok('Paragraph 15.' in sh('pdftotext', lo_pdf, '-'), 'LibreOffice rendering contains the text')

    # ------------------------------------------------ PDF -> images
    task('pdf2img')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([multi_pdf])
    page.wait_for_selector('.cv-file')
    page.fill('#cvPages', '1-2')
    path = run_and_download('multi-images.zip')
    ok(path is not None and zipfile.is_zipfile(path), 'two pages -> zip')
    z = zipfile.ZipFile(path); nm = z.namelist()
    ok(len(nm) == 2 and all(n.endswith('.png') for n in nm), 'zip holds 2 PNGs: %s' % nm)
    im = Image.open(io.BytesIO(z.read(nm[0]))); im.load()
    ok(abs(im.size[0] - round(595 * 150 / 72)) <= 2, 'PNG is 150 dpi A4 wide (%s)' % (im.size,))
    # single page JPG
    page.fill('#cvPages', '1')
    page.select_option('#cvFormat', 'jpg')
    path = run_and_download('page1.jpg')
    ok(open(path, 'rb').read(3) == b'\xff\xd8\xff', 'single page gives a plain JPG')
    # image really shows the text: compare against poppler's own render by size + darkness sanity
    j = Image.open(path).convert('L'); dark = sum(1 for v in j.getdata() if v < 100) / (j.size[0] * j.size[1])
    ok(0.005 < dark < 0.2, 'rendered page contains text-like ink (%.3f dark)' % dark)

    # ------------------------------------------------ wrong file type guard
    task('pdf2txt')
    with page.expect_file_chooser() as fc:
        page.click('#cvBrowse')
    fc.value.set_files([FX + 'pixel.png'])
    page.wait_for_selector('.toast', timeout=5000)
    ok('not a PDF' in page.inner_text('#toasts'), 'non-PDF file rejected with a message')
    ok(page.locator('.cv-file').count() == 0, 'rejected file is not kept')

    # ------------------------------------------------ hand-off to editor
    task('txt2pdf')
    page.fill('#cvText', 'Hand-off test line.')
    page.click('#cvGo'); page.wait_for_selector('#cvOpenEd', timeout=30000)
    page.click('#cvOpenEd')
    page.wait_for_selector('#pages .page canvas.pdf', timeout=15000)
    ok(not page.locator('#convertView').is_visible(), 'back in the editor after Open in the editor')
    ok(page.locator('#pages .page').count() == 1, 'converted PDF is open as a page in the editor')

    # mode toggle keeps the editor document; Convert offers "use the open document"
    page.click('.seg-btn[data-mode=convert]'); task('pdf2txt')
    ok(page.locator('#cvUseOpen').count() == 1, '"Use the open document" offered')
    page.click('#cvUseOpen'); page.wait_for_selector('.cv-file')
    path = run_and_download('open.txt')
    ok('Hand-off test line.' in open(path, encoding='utf-8').read(), 'converted the document currently open in the editor')
    page.screenshot(path=SP + 'c4_result.png')

    page.emulate_media(color_scheme='dark')
    page.screenshot(path=SP + 'c5_dark.png')
    page.set_viewport_size({'width': 820, 'height': 800})
    page.screenshot(path=SP + 'c6_narrow.png')
    b.close()

print('console/page errors:', errors if errors else 'none')
ok(not errors, 'no browser errors')
print('\nFAILED: %d' % len(fails) if fails else '\nALL PASSED')
sys.exit(1 if fails else 0)
