import sys, os, io, csv, zipfile, subprocess, shutil
from playwright.sync_api import sync_playwright
import openpyxl

import os, pathlib, tempfile
ROOT_DIR = str(pathlib.Path(__file__).resolve().parents[2]) + '/'
SP = (os.environ.get('QPDF_E2E_OUT') or tempfile.mkdtemp(prefix='qpdf-e2e-')).rstrip('/') + '/'   # screenshots and downloads land here
LAUNCH = {'headless': True, 'args': ['--no-sandbox']}
if os.environ.get('QPDF_CHROME'): LAUNCH['executable_path'] = os.environ['QPDF_CHROME']       # optional: use an installed Chrome
FX = ROOT_DIR + 'tests/fixtures/'
OUT = SP + 'xl_out/'
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT)
fails = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: fails.append(m)
def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout

# a CSV to feed CSV -> Excel: semicolon, accents, leading zeros, ISO dates, a formula-looking cell, a quoted newline
open(OUT + 'in.csv', 'w', encoding='utf-8').write(
    'Name;Ref;Amount;Date;Note\r\n'
    'Ama Mensah;00123;1234,5;2026-03-14;"line one\nline two"\r\n'
    'Café Zoé;0456;"1,250.00";2026-03-15 08:30:00;=cmd|calc\r\n'
    'Kofi;+233201234567;7;not a date;ok\r\n')
# a Windows-1252 file (not valid UTF-8)
open(OUT + 'ansi.csv', 'wb').write('Name,City\r\nZo\xe9,Z\xfcrich\r\n'.encode('cp1252'))

with sync_playwright() as p:
    b = p.chromium.launch(**LAUNCH)
    ctx = b.new_context(viewport={'width': 1360, 'height': 1000}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8765/index.html')
    page.click('.seg-btn[data-mode=convert]')
    page.wait_for_selector('#cvNav .cv-item')

    def task(tid):
        page.click('.cv-item[data-task=%s]' % tid)
        page.wait_for_selector('#cvGo')

    def load(path):
        with page.expect_file_chooser() as fc:
            page.click('#cvBrowse')
        fc.value.set_files(path)

    def run(name):
        page.click('#cvGo')
        page.wait_for_selector('#cvResult .result.ok, #cvResult .result.bad', timeout=60000)
        if page.locator('#cvResult .result.bad').count():
            return None
        with page.expect_download(timeout=30000) as dl:
            page.click('#cvDl')
        path = OUT + name
        dl.value.save_as(path)
        return path

    def notes():
        return ' || '.join(page.locator('#cvResult .finding').all_inner_texts())

    ok(page.locator('#cvNav .cv-item').count() == 11, 'eleven items in the nav')
    groups = page.locator('#cvNav .cv-group').all_inner_texts()
    ok(groups == ['Make a PDF', 'Take a PDF apart', 'Spreadsheets', 'Examine a file'], 'nav groups: %s' % groups)

    # ---------------------------------------------- Excel -> PDF
    task('xls2pdf')
    ok(page.locator('#cvGo').is_disabled(), 'Excel -> PDF: Go disabled before a file is chosen')
    load(FX + 'book.xlsx')
    page.wait_for_selector('.cv-sheet')
    ok(page.locator('.cv-sheet').count() == 3, 'three sheets listed')
    states = [page.locator('.cv-sheet[data-i="%d"]' % i).is_checked() for i in range(3)]
    ok(states == [True, True, False], 'hidden sheet unticked by default: %s' % states)
    ok(page.locator('.cv-sheetrow .tag').count() == 1, 'hidden sheet is tagged')
    ftxt = page.locator('#cvFiles .finding').all_inner_texts()
    ok(any('hidden' in t and 'Payroll' in t for t in ftxt), 'workbook findings name the hidden sheet')
    ok(any('1904' not in t for t in ftxt), 'findings shown')
    page.screenshot(path=SP + 'x1_xls2pdf_loaded.png')
    path = run('book.pdf')
    ok(path is not None, 'Excel -> PDF produced')
    if path:
        txt = sh('pdftotext', '-layout', path, '-')
        ok('Quarterly sales' in txt, 'PDF has the title')
        ok('GHS 4,206.00' in txt, 'PDF shows the number format as Excel shows it (GHS 4,206.00)')
        ok('2026-03-02' in txt and '14/03/2026 16:30' in txt and '31 Dec 2026' in txt, 'PDF shows the three date formats')
        ok('0123456789' in txt and '00450' in txt, 'PDF keeps the leading zeros')
        ok('secret column' not in txt and 'do not share' not in txt, 'hidden column left out')
        ok('Hidden row item' not in txt, 'hidden row left out')
        ok('K. Boateng' not in txt, 'hidden sheet left out')
        ok('wrap inside its cell' in txt.replace('\n', ' ') or 'wrap' in txt, 'wrapped note is drawn')
        pi = sh('pdfinfo', path)
        ok('Quanttum' in pi or 'Producer' in pi, 'pdfinfo reads the file')
    r = notes()
    ok('hidden row' in r and 'hidden column' in r, 'result reports hidden rows and columns left out: %s' % r[:200])
    page.screenshot(path=SP + 'x2_xls2pdf_done.png')

    # include hidden everything
    page.check('#cvHidden'); page.check('.cv-sheet[data-i="2"]')
    path = run('book_all.pdf')
    txt = sh('pdftotext', '-layout', path, '-') if path else ''
    ok('secret column' in txt and 'Hidden row item' in txt and 'K. Boateng' in txt, 'with "include hidden" the hidden row, column and sheet are drawn')

    # nothing ticked -> disabled
    for i in range(3): page.uncheck('.cv-sheet[data-i="%d"]' % i)
    ok(page.locator('#cvGo').is_disabled(), 'Go disabled when no sheet is ticked')

    # wrong file type
    load(FX + 'table.pdf')
    page.wait_for_timeout(600)
    ok(page.locator('.cv-sheet').count() == 3, 'a PDF dropped on Excel -> PDF is refused (previous file kept)')
    load(OUT + 'in.csv')
    page.wait_for_timeout(600)
    ok(page.locator('.cv-sheet').count() == 3, 'a CSV dropped on Excel -> PDF is refused')

    # ---------------------------------------------- Excel -> CSV
    task('xls2csv')
    load(FX + 'book.xlsx'); page.wait_for_selector('.cv-sheet')
    path = run('book_csv.zip')
    ok(path is not None, 'Excel -> CSV (2 sheets) produced')
    if path:
        z = zipfile.ZipFile(path)
        names = z.namelist()
        ok(names == ['book-Sales.csv', 'book-Notes.csv'], 'zip holds one CSV per ticked sheet: %s' % names)
        sales = list(csv.reader(io.StringIO(z.read('book-Sales.csv').decode('utf-8'))))
        flat = [c for r in sales for c in r]
        ok(sales[1][:4] == ['Item', 'Qty', 'Unit price', 'Total'], 'header row: %s' % sales[1][:4])
        ok('Hidden row item' not in flat and 'secret column' not in flat, 'hidden row/column left out of CSV')
        ok(sales[2][4] == '2026-03-02' and sales[3][4] == '2026-03-14 16:30:42', 'dates exact ISO: %s %s' % (sales[2][4], sales[3][4]))
        ok(sales[2][3] == '4206' and sales[3][2] == '0.3', 'exact values (4206, 0.3 not 0.30000000000000004): %s %s' % (sales[2][3], sales[3][2]))
        ok(sales[2][6] == '0123456789' and sales[3][6] == '00450', 'leading zeros kept')
        ok("'=cmd|calc" in flat, 'formula-looking text is neutralised with an apostrophe')
        ok('Rice - café blend ✓' in flat and 'Yam, "large"' in flat, 'UTF-8 text and quoting round-trip')
        ok(z.read('book-Sales.csv')[:3] != b'\xef\xbb\xbf', 'no BOM by default')
    r = notes()
    ok('apostrophe' in r and 'hidden' in r, 'result notes: %s' % r[:240])
    page.screenshot(path=SP + 'x3_xls2csv.png')

    # single sheet, semicolon, display values, BOM, no protection
    page.uncheck('.cv-sheet[data-i="1"]')
    page.select_option('#cvDelim', ';'); page.select_option('#cvValues', 'display'); page.check('#cvBom'); page.uncheck('#cvProtect')
    path = run('book_sales.csv')
    ok(path is not None and path.endswith('.csv'), 'one ticked sheet gives a bare .csv')
    if path:
        raw = open(path, 'rb').read()
        ok(raw[:3] == b'\xef\xbb\xbf', 'BOM present when asked')
        t = raw.decode('utf-8-sig')
        ok('GHS 4,206.00' in t and '02/03/2026' not in t and '2026-03-02' in t, 'display mode applies number and date formats')
        ok('Maize (50kg bag);12;' in t, 'semicolon separator used')
        ok("=cmd|calc" in t and "'=cmd|calc" not in t, 'protection off leaves text untouched')
        ok('Quarterly sales' in t.splitlines()[0], 'merged title cell appears once in the first row')
    # formulas as text, on the never-calculated file
    page.uncheck('#cvBom'); page.select_option('#cvValues', 'exact'); page.select_option('#cvDelim', ','); page.check('#cvFormulas'); page.check('#cvProtect')
    path = run('book_formulas.csv')
    t = open(path, encoding='utf-8').read() if path else ''
    ok("'=B3*C3" in t, 'formulas as text, and still protected: %s' % t.splitlines()[2][:80] if t else 'no output')
    load(FX + 'nocache.xlsx'); page.wait_for_selector('.cv-sheet')
    page.uncheck('#cvFormulas')
    path = run('nocache.csv')
    ok('never calculated' in notes() or 'no stored result' in notes(), 'never-calculated formulas flagged: %s' % notes()[:200])

    # ---------------------------------------------- CSV -> Excel
    task('csv2xls')
    load(OUT + 'in.csv'); page.wait_for_selector('#cvRmSrc')
    meta = page.locator('#cvFiles .cv-fname span').inner_text()
    ok('semicolon' in meta, 'delimiter detected and shown: %s' % meta)
    path = run('in.xlsx')
    ok(path is not None, 'CSV -> Excel produced')
    if path:
        wb = openpyxl.load_workbook(path)
        ws = wb.active
        ok(wb.sheetnames == ['in'], 'sheet named after the file: %s' % wb.sheetnames)
        ok(ws['A1'].font.b and ws.freeze_panes == 'A2' and ws.auto_filter.ref == 'A1:E4', 'header bold, frozen and filtered (%s, %s)' % (ws.freeze_panes, ws.auto_filter.ref))
        ok(ws['B2'].value == '00123' and ws['B3'].value == '0456', 'leading zeros stay text')
        ok(ws['C2'].value == '1234,5', 'decimal-comma value is not guessed: it stays text %r' % ws['C2'].value)
        ok(ws['C3'].value == 1250.0, '"1,250.00" became 1250: %r' % ws['C3'].value)
        ok(str(ws['D2'].value).startswith('2026-03-14') and ws['D2'].is_date, 'ISO date is a real date: %r' % ws['D2'].value)
        ok(ws['D3'].is_date and ws['D3'].value.hour == 8 and ws['D3'].value.minute == 30, 'date with time is a real datetime: %r' % ws['D3'].value)
        ok(ws['D4'].value == 'not a date', 'non-date text untouched')
        ok(ws['E3'].value == '=cmd|calc' and ws['E3'].data_type == 's', 'formula-looking cell stored as text, not a formula (%s)' % ws['E3'].data_type)
        ok(ws['B4'].value == '+233201234567', 'plus-prefixed phone number kept as text')
        ok(ws['A3'].value == 'Café Zoé', 'accents round-trip')
        ok(ws['E2'].value == 'line one\nline two', 'quoted newline kept inside one cell')
        # independent check: LibreOffice opens it
        lo = OUT + '_lo'; os.makedirs(lo, exist_ok=True)
        subprocess.run(['soffice', '--headless', '--convert-to', 'csv', '--outdir', lo, path], capture_output=True, timeout=180)
        lt = open(lo + '/in.csv', encoding='utf-8').read() if os.path.exists(lo + '/in.csv') else ''
        ok('Café Zoé' in lt and '2026-03-14' in lt, 'LibreOffice opens the workbook and reads it back')
    r = notes()
    ok('never run as formulas' in r or 'never run' in r or 'plain text' in r, 'formula-like cell reported: %s' % r[:240])
    ok('decimal comma' in r, 'decimal-comma cells reported')
    page.screenshot(path=SP + 'x4_csv2xls.png')

    # options off + custom sheet name + scrub
    page.fill('#cvSheetName', 'Raw: data/2026'); page.uncheck('#cvNums'); page.uncheck('#cvDates'); page.uncheck('#cvHeader'); page.check('#cvScrub')
    path = run('in_raw.xlsx')
    if path:
        wb = openpyxl.load_workbook(path); ws = wb.active
        ok(wb.sheetnames == ['Raw_ data_2026'], 'illegal sheet-name characters replaced: %s' % wb.sheetnames)
        ok(ws['C3'].value == '1,250.00' and ws['D2'].value == '2026-03-14', 'with typing off every cell stays text')
        z = zipfile.ZipFile(path)
        ok('docProps/core.xml' not in z.namelist(), 'scrub leaves no document properties')

    # Windows-1252 file
    task('csv2xls'); load(OUT + 'ansi.csv'); page.wait_for_selector('#cvRmSrc')
    path = run('ansi.xlsx')
    if path:
        ws = openpyxl.load_workbook(path).active
        ok(ws['A2'].value == 'Zoé' and ws['B2'].value == 'Zürich', 'non-UTF-8 file decoded as Windows-1252: %r %r' % (ws['A2'].value, ws['B2'].value))
    ok('not valid UTF-8' in notes(), 'encoding fallback is reported')
    # an Excel file is refused by the CSV task
    load(FX + 'book.xlsx'); page.wait_for_timeout(500)
    ok(page.locator('#cvRmSrc').count() == 1 and 'ansi' in page.locator('#cvFiles .cv-fname b').inner_text(), 'an .xlsx dropped on CSV -> Excel is refused')

    # ---------------------------------------------- PDF -> Excel
    task('pdf2xls')
    load(FX + 'table.pdf'); page.wait_for_selector('#cvRmSrc')
    path = run('table.xlsx')
    ok(path is not None, 'PDF -> Excel produced')
    if path:
        ws = openpyxl.load_workbook(path).active
        rows = [[c.value for c in r] for r in ws.iter_rows()]
        flat = [v for r in rows for v in r if v is not None]
        by = {r[0]: r for r in rows if r and r[0]}
        ok(by['Maize (50kg bag)'][1:4] == [12, 350.5, 4206], 'Maize row typed: %s' % by['Maize (50kg bag)'])
        ok(by['Rice - parboiled'][1:4] == [3, 0.3, 0.9], 'Rice row typed: %s' % by['Rice - parboiled'])
        ok(by['Groundnut oil 5L'][1] is None and by['Groundnut oil 5L'][3] == -95, 'blank quantity stays blank; (95.00) is -95: %s' % by['Groundnut oil 5L'])
        ok(by['Pepper, dried'][2:4] == [1250, 5000], 'thousands separators parsed')
        ok(by['Total'][3] == 11998.4, 'total row: %s' % by['Total'])
        ok(sum(1 for r in rows if r[0] == 'Item') == 1, 'repeated header on page 2 kept once')
        ok(any(r[0] == 'Stock report - Kumasi branch' for r in rows) and any(r[0] == 'Prepared by A. Mensah' for r in rows), 'title and footer lines kept')
        ok(len([r for r in rows if r[0] and r[0] not in ('Item',) and isinstance(r[3], (int, float))]) == 14, '14 data rows from two pages')
        ok(all(not isinstance(v, str) or v == v.strip() for v in flat), 'no stray whitespace in cells')
    ok('best effort' in notes().lower() or 'best-effort' in notes().lower(), 'best-effort warning shown')
    ok(page.locator('.cv-preview').count() == 1, 'text preview shown')
    page.screenshot(path=SP + 'x5_pdf2xls.png')
    page.select_option('#cvLayout', 'pages'); page.fill('#cvPages', '1')
    path = run('table_p1.xlsx')
    if path:
        wb = openpyxl.load_workbook(path)
        ok(wb.sheetnames == ['Page 1'], 'one sheet per page, page range honoured: %s' % wb.sheetnames)
    page.fill('#cvPages', '9')
    r = run('x.xlsx')
    ok(r is None and 'Could not convert' in page.locator('#cvResult').inner_text(), 'bad page range gives a clear error')
    # a text PDF with no table
    task('pdf2xls'); load(FX + '../../samples/invoice_edited.pdf'); page.wait_for_selector('#cvRmSrc')
    path = run('invoice.xlsx')
    ok(path is not None, 'any text PDF still converts')

    page.wait_for_timeout(300)
    ok(not errors, 'no JavaScript errors: %s' % errors[:3])
    b.close()

print('\n%d failure(s)' % len(fails))
for f in fails: print(' -', f)
sys.exit(1 if fails else 0)
