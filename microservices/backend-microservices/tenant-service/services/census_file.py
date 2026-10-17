"""Read a Group Life census from a CSV or XLSX upload.

Standard library only (csv + zipfile + xml), so the tenant-service image needs
no spreadsheet dependency. It returns the loose row dicts that
POST …/census/validate and …/census/confirm already take — all checking stays in
group_underwriting / group_benefits; this only turns a file into rows:

  * headers are matched case-insensitively with spaces/hyphens as underscores,
    plus a few aliases ("Employee ID", "Monthly Salary", "Date of Birth" …);
  * XLSX date cells come back as ISO dates, numeric CNIC cells as 13 digits
    (Excel drops the leading zero);
  * columns that aren't part of the census template are reported, not guessed at.

Only the first worksheet is read, and formulas are read as their cached value.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import date, datetime, timedelta
from typing import Any, Dict, List
from xml.etree import ElementTree as ET

from pydantic import BaseModel

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 5000

CENSUS_COLUMNS = (
    "cnic", "name", "dob", "gender", "occupation", "declared_income",
    "employee_id", "designation", "grade", "joining_date", "benefit_class",
    "basic_monthly_salary", "is_smoker", "height_cm", "weight_kg", "loan_amount",
)

_ALIASES = {
    "employee_no": "employee_id", "employee_number": "employee_id", "emp_id": "employee_id",
    "staff_id": "employee_id", "staff_no": "employee_id", "employee_code": "employee_id",
    "full_name": "name", "employee_name": "name", "employee": "name",
    "date_of_birth": "dob", "birth_date": "dob", "birthdate": "dob",
    "cnic_no": "cnic", "cnic_number": "cnic", "national_id": "cnic", "nic": "cnic",
    "sex": "gender",
    "job_title": "designation", "title": "designation", "position": "designation",
    "job": "occupation", "profession": "occupation",
    "annual_income": "declared_income", "annual_salary": "declared_income", "income": "declared_income",
    "declared_annual_income": "declared_income",
    "monthly_salary": "basic_monthly_salary", "basic_salary": "basic_monthly_salary",
    "monthly_basic_salary": "basic_monthly_salary", "basic_monthly": "basic_monthly_salary",
    "date_of_joining": "joining_date", "doj": "joining_date", "join_date": "joining_date",
    "date_joined": "joining_date",
    "class": "benefit_class", "benefit_class_name": "benefit_class", "category": "benefit_class",
    "smoker": "is_smoker", "is_a_smoker": "is_smoker",
    "height": "height_cm", "weight": "weight_kg",
    "loan": "loan_amount", "loan_balance": "loan_amount", "outstanding_balance": "loan_amount",
    "outstanding_loan": "loan_amount", "principal_outstanding": "loan_amount",
}

_TRUE = {"true", "yes", "y", "1", "smoker"}
_FALSE = {"false", "no", "n", "0", "non-smoker", "nonsmoker", "non smoker"}
_DATE_COLUMNS = {"dob", "joining_date"}


class CensusFileError(ValueError):
    """A file that can't be read as a census (wrong type, empty, corrupt, too big)."""


class ParsedCensus(BaseModel):
    filename: str
    rows: List[Dict[str, Any]]
    row_count: int
    columns: List[str]
    ignored_columns: List[str] = []
    warnings: List[str] = []


def _norm_header(raw: Any) -> str:
    key = re.sub(r"[\s\-./]+", "_", str(raw or "").strip().lower()).strip("_")
    return _ALIASES.get(key, key)


def _clean_value(column: str, value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return (value.date() if isinstance(value, datetime) else value).isoformat()
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, (int, float)):
        if column == "cnic":
            return str(int(value)).zfill(13)
        return value
    text = str(value).strip()
    if text == "":
        return None
    if column == "is_smoker":
        low = text.lower()
        if low in _TRUE:
            return True
        if low in _FALSE:
            return False
    return text


def _rows_from_table(table: List[List[Any]], filename: str) -> ParsedCensus:
    table = [r for r in table if any(c not in (None, "") for c in r)]
    if not table:
        raise CensusFileError("The file has no rows.")
    headers = [_norm_header(h) for h in table[0]]
    if not any(h in CENSUS_COLUMNS for h in headers):
        raise CensusFileError(
            "The first row must be the column headings (cnic, name, dob, gender, occupation, declared_income, …)."
        )
    seen, columns, ignored, warnings = set(), [], [], []
    for h in headers:
        if not h:
            continue
        if h in seen:
            warnings.append(f"Column '{h}' appears more than once — the last one wins.")
            continue
        seen.add(h)
        (columns if h in CENSUS_COLUMNS else ignored).append(h)

    data = table[1:]
    if not data:
        raise CensusFileError("The file has column headings but no employee rows.")
    if len(data) > MAX_ROWS:
        raise CensusFileError(f"The file has {len(data):,} rows; the limit is {MAX_ROWS:,} per upload.")

    rows: List[Dict[str, Any]] = []
    for raw in data:
        row: Dict[str, Any] = {}
        for h, cell in zip(headers, raw):
            if h in CENSUS_COLUMNS:
                value = _clean_value(h, cell)
                if value is not None:
                    row[h] = value
        rows.append(row)
    return ParsedCensus(filename=filename, rows=rows, row_count=len(rows), columns=columns,
                        ignored_columns=ignored, warnings=warnings)


# ── CSV ──────────────────────────────────────────────────────────────────

def _read_csv(data: bytes) -> List[List[Any]]:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover — cp1252 maps almost every byte
        raise CensusFileError("The file isn't readable text.")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [list(r) for r in csv.reader(io.StringIO(text), dialect)]


# ── XLSX ─────────────────────────────────────────────────────────────────

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
       "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
       "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
_BUILTIN_DATE_FORMATS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
_EXCEL_EPOCH = date(1899, 12, 30)


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)  # type: ignore[union-attr]
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _is_date_format(code: str) -> bool:
    stripped = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", code or "")
    return bool(re.search(r"[dmyh]", stripped.lower())) and not re.search(r"0|#", stripped)


def _date_style_ids(zf: zipfile.ZipFile) -> set:
    if "xl/styles.xml" not in zf.namelist():
        return set()
    root = ET.fromstring(zf.read("xl/styles.xml"))
    custom = {int(n.get("numFmtId")): n.get("formatCode", "") for n in root.findall(".//m:numFmts/m:numFmt", _NS)}
    out = set()
    for i, xf in enumerate(root.findall(".//m:cellXfs/m:xf", _NS)):
        fid = int(xf.get("numFmtId", "0"))
        if fid in _BUILTIN_DATE_FORMATS or (fid in custom and _is_date_format(custom[fid])):
            out.add(i)
    return out


def _first_sheet_path(zf: zipfile.ZipFile) -> str:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    first = wb.find(".//m:sheets/m:sheet", _NS)
    if first is None:
        raise CensusFileError("The workbook has no sheets.")
    rid = first.get(f"{{{_NS['r']}}}id")
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall("pr:Relationship", _NS):
        if rel.get("Id") == rid:
            target = rel.get("Target", "")
            return target.lstrip("/") if target.startswith("/") else f"xl/{target}"
    raise CensusFileError("Couldn't locate the first worksheet.")


def _read_xlsx(data: bytes) -> List[List[Any]]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise CensusFileError("That isn't a valid .xlsx file.") from exc
    with zf:
        shared: List[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")).findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
        date_styles = _date_style_ids(zf)
        sheet = ET.fromstring(zf.read(_first_sheet_path(zf)))

        table: List[List[Any]] = []
        for row in sheet.findall(".//m:sheetData/m:row", _NS):
            cells: Dict[int, Any] = {}
            for c in row.findall("m:c", _NS):
                idx = _col_index(c.get("r", "A1"))
                kind, style = c.get("t"), int(c.get("s", "0"))
                v = c.find("m:v", _NS)
                if kind == "inlineStr":
                    value: Any = "".join(t.text or "" for t in c.iter(f"{{{_NS['m']}}}t"))
                elif v is None or v.text is None:
                    value = None
                elif kind == "s":
                    value = shared[int(v.text)]
                elif kind in ("str", "e"):
                    value = v.text
                elif kind == "b":
                    value = v.text == "1"
                else:
                    num = float(v.text)
                    value = (_EXCEL_EPOCH + timedelta(days=num)) if style in date_styles else num
                cells[idx] = value
            if cells:
                width = max(cells) + 1
                table.append([cells.get(i) for i in range(width)])
            else:
                table.append([])
        return table


def parse_census_file(filename: str, data: bytes) -> ParsedCensus:
    if not data:
        raise CensusFileError("The uploaded file is empty.")
    if len(data) > MAX_BYTES:
        raise CensusFileError(f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    ext = (filename or "").lower().rsplit(".", 1)[-1] if "." in (filename or "") else ""
    if ext == "xlsx" or data[:2] == b"PK":
        try:
            table = _read_xlsx(data)
        except CensusFileError:
            raise
        except (KeyError, IndexError, ValueError, ET.ParseError) as exc:   # a zip that isn't a workbook, or a damaged one
            raise CensusFileError("That file isn't a readable Excel workbook.") from exc
    elif ext in ("csv", "txt", "tsv"):
        table = _read_csv(data)
    elif ext == "xls":
        raise CensusFileError("Old .xls files aren't supported — save the sheet as .xlsx or .csv.")
    else:
        raise CensusFileError("Upload a .csv or .xlsx file.")
    return _rows_from_table(table, filename)
