"""Tests for the census file reader (services/census_file.py) and its upload endpoint.

The reader tests are pure. The HTTP test goes through FastAPI against a live,
migrated Postgres like test_group_issuance.py, and cleans up after itself.

Run with: docker compose exec tenant-service python test_group_census_upload.py
"""

import asyncio
import io
import os
import zipfile

import httpx

from database import _session_factory
from services.census_file import MAX_ROWS, CensusFileError, parse_census_file
from test_group_census import _cleanup, _master_policy, _setup

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_fixtures", "census_sample.xlsx")


def _expect_error(fn, fragment):
    try:
        fn()
    except CensusFileError as exc:
        assert fragment.lower() in str(exc).lower(), str(exc)
        return
    raise AssertionError(f"expected CensusFileError containing {fragment!r}")


def test_csv_aliases_bom_and_booleans():
    raw = ("﻿Employee ID;Full Name;CNIC No;Date of Birth;Sex;Occupation;Annual Salary;Smoker;Extra\r\n"
           "E1;Sana Iqbal;35201-1111111-1;1991-02-03;Female;Analyst;1800000;yes;x\r\n"
           "E2;Omar Raza;3520122222222;1988-05-06;Male;Engineer;2400000;No;\r\n").encode("utf-8")
    parsed = parse_census_file("census.csv", raw)
    assert parsed.row_count == 2
    assert parsed.rows[0] == {"employee_id": "E1", "name": "Sana Iqbal", "cnic": "35201-1111111-1", "dob": "1991-02-03",
                              "gender": "Female", "occupation": "Analyst", "declared_income": "1800000", "is_smoker": True}
    assert parsed.rows[1]["is_smoker"] is False and parsed.rows[1]["cnic"] == "3520122222222"
    assert parsed.ignored_columns == ["extra"]
    assert "cnic" in parsed.columns and "gender" in parsed.columns


def test_xlsx_dates_numeric_cnic_and_blank_rows():
    parsed = parse_census_file("census.xlsx", open(FIXTURE, "rb").read())
    assert parsed.row_count == 3                                   # the blank row is dropped
    first, second, third = parsed.rows
    assert first["dob"] == "1990-04-12" and first["joining_date"] == "2019-06-01"   # real date cells → ISO
    assert first["cnic"] == "3520112345671" and isinstance(first["declared_income"], int)
    assert first["gender"] == "Female" and first["employee_id"] == "E001" and first["designation"] == "Accountant"
    assert first["basic_monthly_salary"] == 200000 and first["is_smoker"] is False and first["grade"] == "S1"
    assert second["cnic"] == "35202-7654321-9" and second["is_smoker"] is True
    assert "joining_date" not in third and "grade" not in third      # empty cells are omitted, not ""
    assert parsed.ignored_columns == ["notes"]


def test_xlsx_content_sniffed_without_extension_hint():
    assert parse_census_file("upload.bin", open(FIXTURE, "rb").read()).row_count == 3


def test_rejects_unreadable_files():
    _expect_error(lambda: parse_census_file("a.csv", b""), "empty")
    _expect_error(lambda: parse_census_file("a.pdf", b"%PDF-1.4 hello"), ".csv or .xlsx")
    _expect_error(lambda: parse_census_file("a.xls", b"\xd0\xcf\x11\xe0 old"), ".xlsx or .csv")
    _expect_error(lambda: parse_census_file("a.xlsx", b"PK not really a zip"), "valid .xlsx")
    _expect_error(lambda: parse_census_file("a.csv", b"foo,bar\n1,2\n"), "column headings")
    _expect_error(lambda: parse_census_file("a.csv", b"cnic,name\n"), "no employee rows")
    big = "cnic,name\n" + "\n".join(f"{i},n" for i in range(MAX_ROWS + 1))
    _expect_error(lambda: parse_census_file("a.csv", big.encode()), "limit")
    # A zip that is not a workbook.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("hello.txt", "hi")
    _expect_error(lambda: parse_census_file("a.xlsx", buf.getvalue()), "readable Excel workbook")


def test_duplicate_header_is_warned():
    parsed = parse_census_file("a.csv", b"cnic,name,name\n3520111111111,A,B\n")
    assert parsed.warnings and parsed.rows[0]["name"] == "B"


async def test_upload_endpoint():
    import main as app_module
    from routers.users import verify_admin

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            mp_id = await _master_policy(session, fx)
            transport = httpx.ASGITransport(app=app_module.app)
            base = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies/{mp_id}/census/parse"
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.post(base, files={"file": ("staff.xlsx", open(FIXTURE, "rb").read(),
                                                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["row_count"] == 3 and body["rows"][0]["dob"] == "1990-04-12"
                r = await c.post(base, files={"file": ("notes.pdf", b"%PDF", "application/pdf")})
                assert r.status_code == 422 and ".csv or .xlsx" in r.json()["detail"]
                bad = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies/{fx['org_id']}/census/parse"
                r = await c.post(bad, files={"file": ("a.csv", b"cnic,name\n1,a\n", "text/csv")})
                assert r.status_code == 404                           # not this org's master policy
            print("PASS test_upload_endpoint")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _cleanup(session, fx["tenant_id"])


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not asyncio.iscoroutinefunction(fn):
            fn()
            print(f"PASS {name}")
    asyncio.run(test_upload_endpoint())
