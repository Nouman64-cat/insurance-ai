"""Catalogue of software that shows up in document and image metadata.

Patterns are matched case-insensitively against Producer, Creator, CreatorTool,
EXIF Software and similar fields. They are deliberately specific: a false match
here becomes a false alarm downstream, so prefer missing an obscure tool over
matching a common word.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass

from .report import Severity


class ToolKind(str, enum.Enum):
    AI_GENERATOR = "ai_generator"
    PHOTO_EDITOR = "photo_editor"  # pixel editors that can rewrite text in an image
    PHOTO_ADJUST = "photo_adjust"  # crop/colour tools, ordinary on genuine photos
    DESIGN_TOOL = "design_tool"
    PDF_EDITOR = "pdf_editor"  # tools whose main purpose is editing PDF content
    PDF_UTILITY = "pdf_utility"  # merge/compress/print-to-PDF, re-processing only
    OFFICE = "office"
    BROWSER_PRINT = "browser_print"
    REPORT_ENGINE = "report_engine"  # server-side generators used by banks and payroll
    SCRIPT_LIBRARY = "script_library"  # general-purpose code libraries
    SCANNER = "scanner"
    CAMERA = "camera"


@dataclass(frozen=True)
class Tool:
    name: str
    kind: ToolKind
    pattern: re.Pattern[str]


def _t(name: str, kind: ToolKind, pattern: str) -> Tool:
    return Tool(name, kind, re.compile(pattern, re.IGNORECASE))


K = ToolKind
TOOLS: tuple[Tool, ...] = (
    # AI image generators and the apps that wrap them
    _t("Midjourney", K.AI_GENERATOR, r"\bmidjourney\b"),
    _t("DALL-E", K.AI_GENERATOR, r"\bdall[\s\-·.]?e\b"),
    _t("OpenAI", K.AI_GENERATOR, r"\bopenai\b|\bchatgpt\b|\bgpt-?image\b|\bgpt-?4o\b"),
    _t("Stable Diffusion", K.AI_GENERATOR, r"stable[\s_-]?diffusion|\bsdxl\b|\bdreamstudio\b"),
    _t("ComfyUI", K.AI_GENERATOR, r"\bcomfyui\b"),
    _t("AUTOMATIC1111", K.AI_GENERATOR, r"automatic1111|\bforge\s+webui\b"),
    _t("InvokeAI", K.AI_GENERATOR, r"\binvoke\s?ai\b"),
    _t("Fooocus", K.AI_GENERATOR, r"\bfooocus\b"),
    _t("NovelAI", K.AI_GENERATOR, r"\bnovel\s?ai\b"),
    _t("Ideogram", K.AI_GENERATOR, r"\bideogram\b"),
    _t("Adobe Firefly", K.AI_GENERATOR, r"\bfirefly\b"),
    _t("Leonardo.Ai", K.AI_GENERATOR, r"\bleonardo\.?ai\b"),
    _t("Google Imagen", K.AI_GENERATOR, r"google\s+imagen|\bimagen\s*[2-9]\b"),
    _t("Google Gemini", K.AI_GENERATOR, r"\bgemini\b|\bnano[\s-]?banana\b"),
    _t("FLUX", K.AI_GENERATOR, r"\bflux(\.1)?[\s-]*(pro|dev|schnell|kontext|ultra)\b|black\s*forest\s*labs"),
    _t("Recraft", K.AI_GENERATOR, r"\brecraft\b"),
    _t("Playground AI", K.AI_GENERATOR, r"\bplayground\s*(ai|v\d)\b"),
    _t("Bing Image Creator", K.AI_GENERATOR, r"bing\s+image\s+creator"),
    _t("Grok", K.AI_GENERATOR, r"\bgrok\b"),
    _t("NightCafe", K.AI_GENERATOR, r"\bnightcafe\b"),
    _t("Seedream", K.AI_GENERATOR, r"\bseedream\b|\bjimeng\b"),
    _t("Qwen-Image", K.AI_GENERATOR, r"\bqwen[\s-]?image\b"),
    _t("HiDream", K.AI_GENERATOR, r"\bhidream\b"),
    _t("Hunyuan", K.AI_GENERATOR, r"\bhunyuan"),
    # Pixel editors
    _t("Adobe Photoshop", K.PHOTO_EDITOR, r"photoshop(?!\s*lightroom)"),
    _t("GIMP", K.PHOTO_EDITOR, r"\bgimp\b"),
    _t("Photopea", K.PHOTO_EDITOR, r"\bphotopea\b"),
    _t("Paint.NET", K.PHOTO_EDITOR, r"paint\.net"),
    _t("Microsoft Paint", K.PHOTO_EDITOR, r"\bmspaint\b|microsoft\s+paint"),
    _t("Pixelmator", K.PHOTO_EDITOR, r"\bpixelmator\b"),
    _t("Affinity Photo", K.PHOTO_EDITOR, r"affinity\s+photo"),
    _t("PicsArt", K.PHOTO_EDITOR, r"\bpicsart\b"),
    _t("Pixlr", K.PHOTO_EDITOR, r"\bpixlr\b"),
    _t("Krita", K.PHOTO_EDITOR, r"\bkrita\b"),
    _t("Corel PaintShop", K.PHOTO_EDITOR, r"paintshop|paint\s+shop\s+pro"),
    _t("Fotor", K.PHOTO_EDITOR, r"\bfotor\b"),
    _t("Polarr", K.PHOTO_EDITOR, r"\bpolarr\b"),
    # Crop/colour tools
    _t("Adobe Lightroom", K.PHOTO_ADJUST, r"lightroom"),
    _t("Snapseed", K.PHOTO_ADJUST, r"\bsnapseed\b"),
    _t("Google Photos", K.PHOTO_ADJUST, r"google\s+photos"),
    _t("Windows Photos", K.PHOTO_ADJUST, r"windows\s+photo|microsoft\s+photos"),
    _t("Picasa", K.PHOTO_ADJUST, r"\bpicasa\b"),
    _t("IrfanView", K.PHOTO_ADJUST, r"\birfanview\b"),
    _t("XnView", K.PHOTO_ADJUST, r"\bxnview\b"),
    _t("ACDSee", K.PHOTO_ADJUST, r"\bacdsee\b"),
    # Design tools
    _t("Canva", K.DESIGN_TOOL, r"\bcanva\b"),
    _t("Figma", K.DESIGN_TOOL, r"\bfigma\b"),
    _t("Adobe Illustrator", K.DESIGN_TOOL, r"\billustrator\b"),
    _t("Adobe InDesign", K.DESIGN_TOOL, r"\bindesign\b"),
    _t("Adobe Express", K.DESIGN_TOOL, r"adobe\s+express"),
    _t("Affinity Designer/Publisher", K.DESIGN_TOOL, r"affinity\s+(designer|publisher)"),
    _t("Sketch", K.DESIGN_TOOL, r"^sketch\b|bohemian\s+coding"),
    _t("Inkscape", K.DESIGN_TOOL, r"\binkscape\b"),
    _t("CorelDRAW", K.DESIGN_TOOL, r"\bcoreldraw\b"),
    _t("Scribus", K.DESIGN_TOOL, r"\bscribus\b"),
    _t("Microsoft Publisher", K.DESIGN_TOOL, r"microsoft.{0,15}publisher"),
    _t("Microsoft Designer", K.DESIGN_TOOL, r"microsoft\s+designer"),
    _t("VistaCreate", K.DESIGN_TOOL, r"\bvistacreate\b|\bcrello\b"),
    _t("Visme", K.DESIGN_TOOL, r"\bvisme\b"),
    _t("Kittl", K.DESIGN_TOOL, r"\bkittl\b"),
    _t("Penpot", K.DESIGN_TOOL, r"\bpenpot\b"),
    _t("Linearity Curve", K.DESIGN_TOOL, r"\bvectornator\b|linearity\s+curve"),
    # PDF content editors
    _t("PDFescape", K.PDF_EDITOR, r"\bpdfescape\b"),
    _t("Sejda", K.PDF_EDITOR, r"\bsejda\b"),
    _t("PDF-XChange Editor", K.PDF_EDITOR, r"pdf-xchange\s+editor"),
    _t("Foxit PDF Editor", K.PDF_EDITOR, r"foxit\s+(phantompdf|pdf\s+editor|editor)"),
    _t("Nitro PDF", K.PDF_EDITOR, r"\bnitro\s*(pro|pdf\s*pro)\b"),
    _t("Wondershare PDFelement", K.PDF_EDITOR, r"pdfelement|wondershare"),
    _t("Soda PDF", K.PDF_EDITOR, r"soda\s*pdf"),
    _t("pdfFiller", K.PDF_EDITOR, r"pdf\s?filler"),
    _t("DocFly", K.PDF_EDITOR, r"\bdocfly\b"),
    _t("LightPDF", K.PDF_EDITOR, r"\blightpdf\b"),
    _t("Xodo", K.PDF_EDITOR, r"\bxodo\b"),
    _t("PDF Candy", K.PDF_EDITOR, r"pdf\s?candy"),
    _t("Able2Extract", K.PDF_EDITOR, r"able2extract"),
    _t("Master PDF Editor", K.PDF_EDITOR, r"master\s+pdf\s+editor|code\s+industry"),
    _t("PDF Expert", K.PDF_EDITOR, r"pdf\s+expert"),
    _t("ApowerPDF", K.PDF_EDITOR, r"apowerpdf"),
    _t("Icecream PDF Editor", K.PDF_EDITOR, r"icecream\s+pdf"),
    _t("Qoppa PDF Studio", K.PDF_EDITOR, r"pdf\s+studio|qoppa"),
    _t("Unnamed PDF editor", K.PDF_EDITOR, r"\bpdf\s+editor\b"),
    # Re-processing utilities
    _t("Adobe Acrobat", K.PDF_UTILITY, r"adobe\s+acrobat(?!\s+distiller)|acrobat\s+(pro|standard|dc)\b"),
    _t("iLovePDF", K.PDF_UTILITY, r"\bilovepdf\b"),
    _t("Smallpdf", K.PDF_UTILITY, r"\bsmall\s?pdf\b"),
    _t("PDF24", K.PDF_UTILITY, r"\bpdf24\b"),
    _t("Ghostscript", K.PDF_UTILITY, r"ghostscript"),
    _t("qpdf/pikepdf", K.PDF_UTILITY, r"\bqpdf\b|\bpikepdf\b"),
    _t("pypdf", K.PDF_UTILITY, r"\bpypdf\d?\b"),
    _t("PDFsam", K.PDF_UTILITY, r"\bpdfsam\b"),
    _t("Microsoft Print to PDF", K.PDF_UTILITY, r"print\s+to\s+pdf"),
    _t("Virtual PDF printer", K.PDF_UTILITY, r"cutepdf|\bdopdf\b|pdfcreator|bullzip|novapdf|primopdf|pdf\s+architect"),
    _t("Foxit printer", K.PDF_UTILITY, r"foxit\s+(reader|pdf\s+reader)"),
    # Office suites
    _t("Microsoft Word", K.OFFICE, r"microsoft.{0,15}word|pdfmaker.{0,10}word"),
    _t("Microsoft Excel", K.OFFICE, r"microsoft.{0,15}excel|pdfmaker.{0,10}excel"),
    _t("Microsoft PowerPoint", K.OFFICE, r"microsoft.{0,15}powerpoint"),
    _t("LibreOffice/OpenOffice", K.OFFICE, r"libreoffice|openoffice|\bwriter\b|\bcalc\b"),
    _t("Google Docs", K.OFFICE, r"google\s+(docs|sheets|slides)"),
    _t("WPS Office", K.OFFICE, r"\bwps\s+(office|writer|spreadsheets)|kingsoft"),
    _t("Apple Pages/Numbers", K.OFFICE, r"^(pages|numbers|keynote)\b"),
    _t("Zoho", K.OFFICE, r"\bzoho\b"),
    # Browsers and OS print paths
    _t("Chrome/Edge print (Skia)", K.BROWSER_PRINT, r"skia/pdf|chromium|headlesschrome"),
    _t("macOS Quartz", K.BROWSER_PRINT, r"quartz\s+pdfcontext|mac\s+os\s+x.*quartz"),
    _t("Cairo (Firefox/Linux)", K.BROWSER_PRINT, r"\bcairo\s+\d"),
    # Server-side report engines
    _t("iText", K.REPORT_ENGINE, r"\bitext"),
    _t("JasperReports", K.REPORT_ENGINE, r"jasperreports"),
    _t("Crystal Reports", K.REPORT_ENGINE, r"crystal\s+reports"),
    _t("BIRT", K.REPORT_ENGINE, r"\bbirt\b"),
    _t("wkhtmltopdf", K.REPORT_ENGINE, r"wkhtmltopdf"),
    _t("Apache FOP", K.REPORT_ENGINE, r"apache\s+fop|\bfop\s+\d"),
    _t("PDFsharp", K.REPORT_ENGINE, r"pdfsharp|migradoc"),
    _t("TCPDF/mPDF/dompdf", K.REPORT_ENGINE, r"\btcpdf\b|\bmpdf\b|\bdompdf\b"),
    _t("Aspose", K.REPORT_ENGINE, r"\baspose\b"),
    _t("Telerik", K.REPORT_ENGINE, r"\btelerik\b"),
    _t("Syncfusion", K.REPORT_ENGINE, r"\bsyncfusion\b"),
    _t("DevExpress", K.REPORT_ENGINE, r"devexpress|xtrareports"),
    _t("ActiveReports", K.REPORT_ENGINE, r"activereports|grapecity"),
    _t("Stimulsoft", K.REPORT_ENGINE, r"stimulsoft"),
    _t("PDFlib", K.REPORT_ENGINE, r"\bpdflib\b"),
    _t("Prince", K.REPORT_ENGINE, r"\bprince\s+\d|princexml"),
    _t("WeasyPrint", K.REPORT_ENGINE, r"weasyprint"),
    _t("Oracle BI Publisher", K.REPORT_ENGINE, r"bi\s+publisher|oracle"),
    _t("SAP", K.REPORT_ENGINE, r"\bsap\s+(netweaver|smart\s?forms|adobe)|\bsapgui\b"),
    _t("IronPDF/SelectPdf/EvoPdf", K.REPORT_ENGINE, r"ironpdf|selectpdf|evo\s?pdf"),
    _t("Adobe PDF Library/Distiller", K.REPORT_ENGINE, r"adobe\s+pdf\s+library|acrobat\s+distiller"),
    # Code libraries that LLM tools and quick scripts typically use
    _t("ReportLab", K.SCRIPT_LIBRARY, r"reportlab"),
    _t("FPDF", K.SCRIPT_LIBRARY, r"\bfpdf2?\b|pyfpdf"),
    _t("Matplotlib", K.SCRIPT_LIBRARY, r"matplotlib"),
    _t("PDFKit (Node)", K.SCRIPT_LIBRARY, r"\bpdfkit\b"),
    _t("jsPDF", K.SCRIPT_LIBRARY, r"\bjspdf\b"),
    _t("pdf-lib", K.SCRIPT_LIBRARY, r"\bpdf-lib\b"),
    # Scanners and OCR
    _t("CamScanner", K.SCANNER, r"camscanner|intsig"),
    _t("Adobe Scan", K.SCANNER, r"adobe\s+scan"),
    _t("Microsoft Lens", K.SCANNER, r"(office|microsoft)\s+lens"),
    _t("Genius Scan", K.SCANNER, r"genius\s+scan"),
    _t("Scanner app", K.SCANNER, r"scanner\s+pro|turboscan|tiny\s?scanner|\bvflat\b|scanbot|\bnaps2\b|clear\s?scan(ner)?"),
    _t("Office scanner/MFP", K.SCANNER, r"epson\s+scan|hp\s+(scan|smart)|\bricoh\b|kyocera|konica|bizhub|xerox|lexmark|imagerunner|sharp\s+mx|brother\s+(scan|mfc)|canon\s+(scan|mf)"),
    _t("OCR software", K.SCANNER, r"abbyy|finereader|tesseract|ocrmypdf|omnipage|readiris"),
    # Phone and camera firmware
    _t("Phone camera", K.CAMERA, r"^(android|ios)\b|\bhdr\+|^\d+(\.\d+)*$|camera\s+app|samsung|xiaomi|miui|oneplus|huawei|oppo|vivo|realme"),
)

# Severity of a tool appearing in a PDF's Producer/Creator fields, by declared document type.
# bank_statement is strict because banks issue statements from server-side systems, not from desktop tools.
PDF_TOOL_SEVERITY: dict[ToolKind, dict[str, Severity]] = {
    K.AI_GENERATOR: {"default": Severity.CRITICAL},
    K.PHOTO_EDITOR: {"default": Severity.HIGH},
    K.DESIGN_TOOL: {"default": Severity.MEDIUM, "bank_statement": Severity.HIGH},
    K.PDF_EDITOR: {"default": Severity.MEDIUM, "bank_statement": Severity.HIGH},
    K.PDF_UTILITY: {"default": Severity.LOW},
    K.OFFICE: {"default": Severity.INFO, "bank_statement": Severity.MEDIUM},
    K.SCRIPT_LIBRARY: {"default": Severity.INFO, "bank_statement": Severity.LOW},
    K.PHOTO_ADJUST: {"default": Severity.LOW},
    K.BROWSER_PRINT: {"default": Severity.INFO},
    K.REPORT_ENGINE: {"default": Severity.INFO},
    K.SCANNER: {"default": Severity.INFO},
    K.CAMERA: {"default": Severity.INFO},
}

# Severity of a tool named in an image's EXIF/XMP software fields.
IMAGE_TOOL_SEVERITY: dict[ToolKind, Severity] = {
    K.AI_GENERATOR: Severity.CRITICAL,
    K.PHOTO_EDITOR: Severity.HIGH,
    K.DESIGN_TOOL: Severity.HIGH,
    K.PDF_EDITOR: Severity.MEDIUM,
    K.OFFICE: Severity.LOW,
    K.PHOTO_ADJUST: Severity.LOW,
    K.PDF_UTILITY: Severity.INFO,
    K.SCRIPT_LIBRARY: Severity.LOW,
    K.BROWSER_PRINT: Severity.INFO,
    K.REPORT_ENGINE: Severity.INFO,
    K.SCANNER: Severity.INFO,
    K.CAMERA: Severity.INFO,
}

TOOL_KIND_DESCRIPTION: dict[ToolKind, str] = {
    K.AI_GENERATOR: "an AI image generator",
    K.PHOTO_EDITOR: "a pixel editor that can rewrite text in an image",
    K.PHOTO_ADJUST: "a photo crop/colour tool",
    K.DESIGN_TOOL: "a graphic design tool that can recreate any document layout",
    K.PDF_EDITOR: "a PDF editor whose main purpose is changing PDF content",
    K.PDF_UTILITY: "a PDF re-processing utility (merge, compress, print-to-PDF)",
    K.OFFICE: "an office suite",
    K.BROWSER_PRINT: "a browser or operating-system print path",
    K.REPORT_ENGINE: "a server-side report engine typical of bank and payroll systems",
    K.SCRIPT_LIBRARY: "a general-purpose code library",
    K.SCANNER: "scanning or OCR software",
    K.CAMERA: "phone or camera firmware",
}


def identify_tools(text: str | None) -> list[Tool]:
    """Return every catalogued tool named in ``text``, most specific kinds first."""
    if not text:
        return []
    text = text.strip()
    found = [t for t in TOOLS if t.pattern.search(text)]
    # "Adobe Photoshop Lightroom" style collisions are prevented in the patterns; this
    # only removes the generic catch-all when a named editor already matched.
    if any(t.kind is K.PDF_EDITOR and t.name != "Unnamed PDF editor" for t in found):
        found = [t for t in found if t.name != "Unnamed PDF editor"]
    return found


def pdf_tool_severity(kind: ToolKind, doc_type: str | None) -> Severity:
    table = PDF_TOOL_SEVERITY[kind]
    return table.get(doc_type or "default", table["default"])


# IPTC digital source types (https://cv.iptc.org/newscodes/digitalsourcetype/).
# C2PA manifests and XMP Iptc4xmpExt:DigitalSourceType both use this vocabulary.
DIGITAL_SOURCE_TYPES: dict[str, tuple[Severity, str]] = {
    "trainedAlgorithmicMedia": (Severity.CRITICAL, "generated by a trained AI model"),
    "compositeWithTrainedAlgorithmicMedia": (Severity.CRITICAL, "edited with or composited from AI-generated content"),
    "algorithmicMedia": (Severity.HIGH, "generated by an algorithm, not captured"),
    "compositeSynthetic": (Severity.HIGH, "a composite that includes synthetic elements"),
    "composite": (Severity.MEDIUM, "a composite of several images"),
    "digitalCreation": (Severity.MEDIUM, "created digitally by a person rather than captured"),
    "algorithmicallyEnhanced": (Severity.LOW, "algorithmically enhanced (often phone processing)"),
    "minorHumanEdits": (Severity.LOW, "lightly edited by a person"),
    "screenCapture": (Severity.INFO, "a screenshot"),
    "digitalCapture": (Severity.INFO, "captured by a camera or scanner"),
    "computationalCapture": (Severity.INFO, "captured by a phone camera with computational processing"),
    "negativeFilm": (Severity.INFO, "scanned from film"),
    "positiveFilm": (Severity.INFO, "scanned from film"),
    "print": (Severity.INFO, "scanned from a print"),
}


def digital_source_type(value: str) -> tuple[str, Severity, str] | None:
    """Map an IPTC digital source type URI or bare term to (term, severity, meaning)."""
    term = value.strip().rstrip("/").rsplit("/", 1)[-1]
    if term in DIGITAL_SOURCE_TYPES:
        severity, meaning = DIGITAL_SOURCE_TYPES[term]
        return term, severity, meaning
    return None
