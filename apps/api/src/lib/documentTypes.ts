// Central registry for the document file types the app accepts, plus the small
// predicates that drive per-type behaviour (PDF rendition, native rendering,
// storage content-types). Keeping this in one module means the upload gate, the
// LLM read path, the tabular extractor, and the download route all agree on the
// exact same set of extensions and the exact same policy for each.

export const ALLOWED_DOCUMENT_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
]);

// Human-readable form of ALLOWED_DOCUMENT_TYPES for the "Unsupported file type"
// error strings. Kept in declaration order so the message matches the set.
export const ALLOWED_DOCUMENT_TYPES_LABEL =
  "pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt";

const WORD_TYPES = new Set(["docx", "doc"]);
const SPREADSHEET_TYPES = new Set(["xlsx", "xlsm", "xls"]);
const PRESENTATION_TYPES = new Set(["pptx", "ppt"]);

export function isWordDocumentType(fileType: string | null | undefined) {
  return WORD_TYPES.has((fileType ?? "").toLowerCase());
}

export function isSpreadsheetDocumentType(fileType: string | null | undefined) {
  return SPREADSHEET_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPresentationDocumentType(fileType: string | null | undefined) {
  return PRESENTATION_TYPES.has((fileType ?? "").toLowerCase());
}

/**
 * Whether a file type gets a PDF rendition (via LibreOffice) for the display
 * viewer.
 *
 * Word and PowerPoint files do: the frontend has no native renderer for them,
 * so we convert once at upload and show the PDF.
 *
 * Spreadsheets intentionally do NOT: they are rendered natively as a grid in
 * the frontend from the raw file bytes rather than a PDF rendition, because a
 * PDF clips wide/tall sheets. Their bytes are served as-is.
 */
export function shouldConvertToPdf(fileType: string | null | undefined) {
  const normalized = (fileType ?? "").toLowerCase();
  return (
    isWordDocumentType(normalized) || isPresentationDocumentType(normalized)
  );
}

/** The HTTP content-type to store/serve raw bytes of a given document type. */
export function contentTypeForDocumentType(fileType: string | null | undefined) {
  switch ((fileType ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "doc":
      return "application/msword";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case "xls":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    default:
      return "application/octet-stream";
  }
}
