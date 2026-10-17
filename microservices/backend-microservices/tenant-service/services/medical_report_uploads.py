"""Token-scoped medical reports: validate files and persist only in S3."""
import asyncio
from pathlib import PurePosixPath
from fastapi import HTTPException
from routers.artifacts import _s3_client, _S3_BUCKET, _AWS_REGION

MAX_REPORT_BYTES = 20 * 1024 * 1024
REPORT_MIME = {'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg',
               'jpeg': 'image/jpeg', 'tif': 'image/tiff', 'tiff': 'image/tiff', 'bmp': 'image/bmp'}


def validate_report(filename: str, data: bytes) -> tuple[str, str]:
    filename = PurePosixPath((filename or '').replace('\\', '/')).name
    if len(filename) > 255:
        raise HTTPException(400, "Please shorten the report filename to 255 characters or fewer.")
    ext = filename.rsplit('.', 1)[-1].lower()
    if ext not in REPORT_MIME:
        raise HTTPException(400, 'Upload a PDF, JPEG, PNG, TIFF or BMP report.')
    if not data:
        raise HTTPException(400, 'The report file is empty.')
    if len(data) > MAX_REPORT_BYTES:
        raise HTTPException(413, 'Each report must be 20 MB or smaller.')
    valid = {'pdf': data.startswith(b'%PDF-'), 'png': data.startswith(b'\x89PNG\r\n\x1a\n'),
             'jpg': data.startswith(b'\xff\xd8\xff'), 'jpeg': data.startswith(b'\xff\xd8\xff'),
             'tif': data.startswith((b'II*\x00', b'MM\x00*')), 'tiff': data.startswith((b'II*\x00', b'MM\x00*')),
             'bmp': data.startswith(b'BM')}
    if not valid[ext]:
        raise HTTPException(400, 'The file contents do not match its format. Upload the original report.')
    return filename, REPORT_MIME[ext]


async def store_report(data: bytes, key: str, mime: str) -> str:
    # No local-storage fallback: an acknowledged report must be in S3.
    try:
        await asyncio.to_thread(lambda: _s3_client().put_object(
            Bucket=_S3_BUCKET, Key=key, Body=data, ContentType=mime))
    except Exception as exc:
        raise HTTPException(502, 'Report storage is temporarily unavailable. Please retry your upload.') from exc
    return f'https://{_S3_BUCKET}.s3.{_AWS_REGION}.amazonaws.com/{key}'
