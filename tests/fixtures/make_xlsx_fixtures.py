"""Builds the Excel fixtures used by tests/sheets.test.js.   python3 make_xlsx_fixtures.py

Needs: openpyxl, and LibreOffice (soffice) on the PATH.
  nocache.xlsx  - written by openpyxl. Formulas have NO stored results (the file was never calculated).
  book.xlsx     - the same workbook re-saved by LibreOffice, which calculates and stores the results.
  mac1904.xlsx  - uses the 1904 date system.
All names and numbers are fictional.
"""
import datetime, os, shutil, subprocess, sys
import openpyxl
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils.datetime import CALENDAR_MAC_1904

HERE = os.path.dirname(os.path.abspath(__file__))


def book(epoch1904=False):
    wb = openpyxl.Workbook()
    if epoch1904:
        wb.epoch = CALENDAR_MAC_1904
    ws = wb.active
    ws.title = 'Sales'
    ws.merge_cells('A1:D1')
    ws['A1'] = 'Quarterly sales - Kumasi branch'
    ws['A1'].font = Font(bold=True, size=14)
    for i, h in enumerate(['Item', 'Qty', 'Unit price', 'Total', 'Date', 'Paid', 'Ref'], 1):
        c = ws.cell(row=2, column=i, value=h)
        c.font = Font(bold=True)
        c.fill = PatternFill('solid', fgColor='FFFF00')
    data = [
        ['Maize (50kg bag)', 12, 350.5, '=B3*C3', datetime.date(2026, 3, 2), True, '0123456789'],
        ['Rice - café blend ✓', 3, 0.1 + 0.2, '=B4*C4', datetime.datetime(2026, 3, 14, 16, 30, 42), False, '00450'],
        ['Yam, "large"', 40, 12.345, '=B5*C5', datetime.date(2026, 12, 31), True, None],
        ['Hidden row item', 1, 1, '=B6*C6', None, None, None],
        ['Percent test', 0.256, 1500000, None, None, None, None],
    ]
    for r, row in enumerate(data, 3):
        for c, v in enumerate(row, 1):
            if v is not None:
                ws.cell(row=r, column=c, value=v)
    ws['G5'] = '=cmd|calc'
    ws['G5'].data_type = 's'          # text that merely LOOKS like a formula
    ws['C3'].number_format = '#,##0.00'
    ws['C4'].number_format = '0.00'
    ws['C5'].number_format = '0.000'
    ws['D3'].number_format = '"GHS" #,##0.00'
    ws['D4'].number_format = '"GHS" #,##0.00'
    ws['D5'].number_format = '"GHS" #,##0.00'
    ws['E3'].number_format = 'yyyy-mm-dd'
    ws['E4'].number_format = 'dd/mm/yyyy hh:mm'
    ws['E5'].number_format = 'd mmm yyyy'
    ws['B7'].number_format = '0.0%'
    ws['C7'].number_format = '#,##0'
    ws['A3'].comment = Comment('Checked against the delivery note.', 'Ama')
    ws.row_dimensions[6].hidden = True
    ws['H2'] = 'secret column'
    ws['H3'] = 'do not share'
    ws.column_dimensions['H'].hidden = True
    ws.column_dimensions['A'].width = 26
    ws.column_dimensions['G'].width = 14

    notes = wb.create_sheet('Notes')
    notes['A1'] = 'A long note that should wrap inside its cell when the sheet is drawn on a page, because the cell asks for wrapping.'
    notes['A1'].alignment = Alignment(wrap_text=True, vertical='top')
    notes.column_dimensions['A'].width = 30
    notes['A2'] = 'Right aligned'
    notes['A2'].alignment = Alignment(horizontal='right')

    pay = wb.create_sheet('Payroll')
    pay['A1'] = 'Name'
    pay['B1'] = 'Salary'
    pay['A2'] = 'K. Boateng'
    pay['B2'] = 4200
    pay.sheet_state = 'hidden'
    return wb


raw = os.path.join(HERE, 'nocache.xlsx')
book().save(raw)
tmp = os.path.join(HERE, '_lo')
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp)
subprocess.run(['soffice', '--headless', '--convert-to', 'xlsx', '--outdir', tmp, raw], check=True, capture_output=True, timeout=180)
shutil.move(os.path.join(tmp, 'nocache.xlsx'), os.path.join(HERE, 'book.xlsx'))
shutil.rmtree(tmp)

wb = openpyxl.Workbook()
wb.epoch = CALENDAR_MAC_1904
wb.active['A1'] = datetime.date(2026, 3, 2)
wb.active['A1'].number_format = 'yyyy-mm-dd'
wb.active['A2'] = 'Mac workbook'
wb.save(os.path.join(HERE, 'mac1904.xlsx'))
print('ok', [f for f in sorted(os.listdir(HERE)) if f.endswith('.xlsx')])
