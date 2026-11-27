"""Runs every browser test against the local server and prints a one-line summary for each.

    pip install playwright pillow openpyxl python-docx reportlab    (and: playwright install chromium)
    python tests/e2e/run_all.py

The server is started for the run if nothing is listening on 127.0.0.1:8765.
Some tests compare the app's output with independent tools and skip nothing: they need poppler (pdftotext, pdfinfo),
LibreOffice (soffice), python-docx, openpyxl and Pillow on the machine.
Screenshots and downloads go to $QPDF_E2E_OUT, or a temporary folder. Set QPDF_CHROME to use an installed Chrome.
"""
import os, pathlib, socket, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TESTS = ['editor_e2e.py', 'convert_e2e.py', 'excel_e2e.py', 'report_e2e.py', 'office_e2e.py', 'signature_e2e.py', 'mobile_e2e.py']


def listening():
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex(('127.0.0.1', 8765)) == 0
    finally:
        s.close()


server = None
if not listening():
    server = subprocess.Popen([sys.executable, str(ROOT / 'server.py')], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if listening():
            break
        time.sleep(0.25)

bad = 0
try:
    for t in TESTS:
        r = subprocess.run([sys.executable, str(HERE / t)], capture_output=True, text=True, env=os.environ.copy())
        lines = r.stdout.splitlines()
        npass = sum(1 for l in lines if l.startswith('PASS'))
        nfail = [l for l in lines if l.startswith('FAIL')]
        status = 'ok  ' if r.returncode == 0 and not nfail else 'FAIL'
        print('%s %-18s %3d checks passed%s' % (status, t, npass, '' if status == 'ok  ' else '   <- ' + (nfail[0] if nfail else (r.stderr.strip().splitlines() or ['crashed'])[-1])))
        bad += status != 'ok  '
finally:
    if server:
        server.terminate()
sys.exit(1 if bad else 0)
