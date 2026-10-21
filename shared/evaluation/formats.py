"""Reading and writing cases as JSONL, JSON and CSV.

JSONL is the exchange and snapshot format: one canonical case per line. JSON takes either an array of cases or
{"cases": [...]}. CSV is for spreadsheets: the identifying fields are plain columns, and everything structured (input,
expected, assertions...) is a JSON text in its own column, so a CSV round-trips without losing anything.
"""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List

from shared.evaluation.canonical import canonical_json, parse_jsonl, to_jsonl

FORMATS = ("jsonl", "json", "csv")
EXTENSIONS = {"jsonl": "jsonl", "ndjson": "jsonl", "json": "json", "csv": "csv"}
CONTENT_TYPES = {"jsonl": "application/x-ndjson", "json": "application/json", "csv": "text/csv"}

CSV_SCALAR = ["schema_version", "case_id", "title", "workflow", "turn_mode", "stage", "category", "scenario_type",
              "difficulty", "severity", "tags"]
CSV_JSON = ["input", "expected", "reference_context", "assertions", "semantic_criteria", "evaluation", "source",
            "approval", "metadata"]
CSV_COLUMNS = CSV_SCALAR + CSV_JSON
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class Reject:
    position: int        # line (jsonl), array element (json) or row (csv), counting from 1; 0 means the whole file
    error: str


@dataclass
class ParseResult:
    records: List[dict] = field(default_factory=list)
    rejects: List[Reject] = field(default_factory=list)


def detect_format(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in EXTENSIONS:
        raise ValueError(f"cannot tell the format of {filename!r}; use .jsonl, .json or .csv")
    return EXTENSIONS[ext]


def parse_cases(data: bytes, fmt: str) -> ParseResult:
    if fmt not in FORMATS:
        raise ValueError(f"unsupported format {fmt!r}; use one of {', '.join(FORMATS)}")
    try:
        data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return ParseResult(rejects=[Reject(0, "the file is not valid UTF-8 text")])
    if fmt == "jsonl":
        return _parse_jsonl(data)
    if fmt == "json":
        return _parse_json(data)
    return _parse_csv(data)


def _parse_jsonl(data: bytes) -> ParseResult:
    result = ParseResult()
    for line, value, error in parse_jsonl(data):
        if error:
            result.rejects.append(Reject(line, error))
        elif not isinstance(value, dict):
            result.rejects.append(Reject(line, "each line must be a JSON object"))
        else:
            result.records.append(value)
    return result


def _parse_json(data: bytes) -> ParseResult:
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except ValueError as exc:
        return ParseResult(rejects=[Reject(0, f"invalid JSON: {exc}")])
    items = doc.get("cases") if isinstance(doc, dict) else doc
    if not isinstance(items, list):
        return ParseResult(rejects=[Reject(0, 'expected a JSON array of cases or an object with a "cases" array')])
    result = ParseResult()
    for index, item in enumerate(items, start=1):
        if isinstance(item, dict):
            result.records.append(item)
        else:
            result.rejects.append(Reject(index, "each case must be a JSON object"))
    return result


def _unguard(cell: str) -> str:
    """Undo the spreadsheet formula guard added on export (a leading ' before = + - @)."""
    return cell[1:] if len(cell) > 1 and cell[0] == "'" and cell[1] in "=+-@\t\r" else cell


def _parse_csv(data: bytes) -> ParseResult:
    csv.field_size_limit(16 * 1024 * 1024)
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""))
    if reader.fieldnames is None:
        return ParseResult(rejects=[Reject(0, "the CSV file has no header row")])
    unknown = [c for c in reader.fieldnames if c not in CSV_COLUMNS]
    if unknown:
        return ParseResult(rejects=[Reject(0, f"unknown CSV column(s): {', '.join(unknown)}. Expected: {', '.join(CSV_COLUMNS)}")])
    result = ParseResult()
    for row_number, row in enumerate(reader, start=2):          # row 1 is the header
        record: Dict[str, Any] = {}
        try:
            for column in CSV_SCALAR:
                cell = (row.get(column) or "").strip()
                if not cell:
                    continue
                cell = _unguard(cell)
                record[column] = [t.strip() for t in cell.replace(",", ";").split(";") if t.strip()] if column == "tags" else cell
            for column in CSV_JSON:
                cell = (row.get(column) or "").strip()
                if cell:
                    record[column] = json.loads(cell)
        except ValueError as exc:
            result.rejects.append(Reject(row_number, f"column holds invalid JSON: {exc}"))
            continue
        if record:
            result.records.append(record)
    return result


def serialize_cases(cases: List[dict], fmt: str) -> bytes:
    if fmt == "jsonl":
        return to_jsonl(cases)
    if fmt == "json":
        return (json.dumps({"cases": cases}, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    if fmt == "csv":
        out = io.StringIO(newline="")
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        for case in cases:
            row: List[str] = []
            for column in CSV_SCALAR:
                value = case.get(column)
                if column == "tags":
                    cell = ";".join(value or [])
                else:
                    cell = "" if value is None else str(value)
                row.append("'" + cell if cell.startswith(_FORMULA_START) else cell)
            for column in CSV_JSON:
                row.append(canonical_json(case[column]) if column in case else "")
            writer.writerow(row)
        return out.getvalue().encode("utf-8")
    raise ValueError(f"unsupported format {fmt!r}; use one of {', '.join(FORMATS)}")
