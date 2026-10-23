"""Builders for synthetic genuine and forged test documents."""

from __future__ import annotations

import io
import re
import struct
import tempfile
from pathlib import Path

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageDraw

PAYSLIP = (
    b"BT /F1 12 Tf 72 700 Td (Net Pay 45,000) Tj ET\n"
    b"BT /F1 12 Tf 72 680 Td (Basic Salary 30,000) Tj ET\n"
    b"BT /F1 12 Tf 72 660 Td (Allowances 15,000) Tj ET\n"
)

# "Net Pay " in 12pt Helvetica is 49.4pt wide, so "45,000" spans x=121..158 on the baseline y=700.
VALUE_BOX = b"115 695 50 20 re f\n"


def helvetica(basefont: str = "Helvetica") -> Dictionary:
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + basefont))
    if basefont != "Helvetica":
        font.FirstChar, font.LastChar = 32, 126
        font.Widths = Array([556] * 95)
    return font


def make_pdf(content: bytes = PAYSLIP, info: dict[str, str] | None = None, fonts: dict[str, Dictionary] | None = None,
             extgstate: dict[str, Dictionary] | None = None, linearize: bool = False, annots: list[Dictionary] | None = None,
             image: bytes | None = None) -> bytes:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    resources = Dictionary(Font=Dictionary({f"/{k}": v for k, v in (fonts or {"F1": helvetica()}).items()}))
    if extgstate:
        resources.ExtGState = Dictionary({f"/{k}": v for k, v in extgstate.items()})
    if image:
        img = Image.open(io.BytesIO(image))
        resources.XObject = Dictionary(Im1=pikepdf.Stream(pdf, image, Type=Name.XObject, Subtype=Name.Image,
                                                          Width=img.width, Height=img.height, ColorSpace=Name.DeviceRGB,
                                                          BitsPerComponent=8, Filter=Name.DCTDecode))
    page.Resources = resources
    page.Contents = pdf.make_stream(content)
    if annots:
        page.Annots = Array([pdf.make_indirect(a) for a in annots])
    for k, v in (info or {}).items():
        pdf.docinfo[Name("/" + k)] = v
    buf = io.BytesIO()
    pdf.save(buf, compress_streams=False, object_stream_mode=pikepdf.ObjectStreamMode.disable,
             linearize=linearize, deterministic_id=True)
    return buf.getvalue()


def content_object_number(data: bytes) -> int:
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return pdf.pages[0].obj.Contents.objgen[0]


def append_update(data: bytes, obj_num: int, new_stream: bytes, producer: str | None = None) -> bytes:
    """Append an incremental update that replaces one stream object, as a PDF editor's 'Save' does."""
    prev = int(re.findall(rb"startxref\s+(\d+)", data)[-1])
    trailer = re.findall(rb"trailer\s*<<(.*?)>>\s*startxref", data, re.S)[-1]
    size = int(re.search(rb"/Size\s+(\d+)", trailer).group(1))
    root = re.search(rb"/Root\s+(\d+\s+\d+\s+R)", trailer).group(1)
    out = bytearray(data)
    if not out.endswith(b"\n"):
        out += b"\n"
    entries = []
    entries.append((obj_num, len(out)))
    out += b"%d 0 obj\n<< /Length %d >>\nstream\n" % (obj_num, len(new_stream)) + new_stream + b"\nendstream\nendobj\n"
    info_ref = b""
    if producer:
        entries.append((size, len(out)))
        out += b"%d 0 obj\n<< /Producer (%s) >>\nendobj\n" % (size, producer.encode())
        info_ref = b"/Info %d 0 R " % size
        size += 1
    xref_at = len(out)
    out += b"xref\n"
    for num, offset in sorted(entries):
        out += b"%d 1\n%010d 00000 n \n" % (num, offset)
    out += b"trailer\n<< /Size %d /Root %s %s/Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (size, root, info_ref, prev, xref_at)
    return bytes(out)


def sign_pdf(data: bytes) -> bytes:
    """Sign with a throwaway self-signed certificate using pyHanko."""
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Bank Statements")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=30))
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True)
            .sign(key, hashes.SHA256()))
    with tempfile.TemporaryDirectory() as tmp:
        key_file, cert_file = Path(tmp, "key.pem"), Path(tmp, "cert.pem")
        key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                               serialization.NoEncryption()))
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        signer = signers.SimpleSigner.load(str(key_file), str(cert_file))
    out = signers.sign_pdf(IncrementalPdfFileWriter(io.BytesIO(data)),
                           signers.PdfSignatureMetadata(field_name="Sig1"), signer=signer)
    return out.getvalue()


def document_photo(seed: int = 1, size=(800, 1000)) -> Image.Image:
    """A grey page with dark text-like bars, standing in for a photographed document."""
    rng = np.random.default_rng(seed)
    img = Image.new("RGB", size, (235, 235, 230))
    draw = ImageDraw.Draw(img)
    y = 60
    while y < size[1] - 60:
        x = 60
        while x < size[0] - 120:
            w = int(rng.integers(30, 140))
            draw.rectangle([x, y, x + w, y + 14], fill=(40, 40, 50))
            x += w + int(rng.integers(10, 30))
        y += int(rng.integers(28, 60))
    draw.rectangle([60, 20, 300, 45], fill=(20, 60, 140))
    return img


def jpeg_bytes(img: Image.Image, quality: int = 85, exif: Image.Exif | None = None, xmp: bytes | None = None) -> bytes:
    buf = io.BytesIO()
    kwargs = {"quality": quality}
    if exif is not None:
        kwargs["exif"] = exif
    if xmp is not None:
        kwargs["xmp"] = xmp
    img.save(buf, "JPEG", **kwargs)
    return buf.getvalue()


def with_exif_thumbnail(jpeg: bytes, thumbnail: bytes) -> bytes:
    """Insert an EXIF APP1 whose IFD1 carries ``thumbnail``, like a camera does."""
    ifd1_at = 8 + 2 + 4
    thumb_at = ifd1_at + 2 + 2 * 12 + 4
    tiff = (b"II*\x00" + struct.pack("<I", 8) + struct.pack("<H", 0) + struct.pack("<I", ifd1_at)
            + struct.pack("<H", 2)
            + struct.pack("<HHII", 0x0201, 4, 1, thumb_at)
            + struct.pack("<HHII", 0x0202, 4, 1, len(thumbnail))
            + struct.pack("<I", 0) + thumbnail)
    payload = b"Exif\x00\x00" + tiff
    return jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload + jpeg[2:]


AI_XMP = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
 Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>
</rdf:RDF></x:xmpmeta>"""
