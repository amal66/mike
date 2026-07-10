import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { spreadsheetToLLMText } from "../spreadsheet";

/** Build an .xlsx buffer from a sheet name + array-of-arrays grid. */
function makeXlsx(
    sheetName: string,
    rows: (string | number)[][],
): Buffer {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("spreadsheetToLLMText", () => {
    it("renders a cell-addressed markdown table with a column-letter header", () => {
        const buf = makeXlsx("Budget", [
            ["Item", "Amount"],
            ["Rent", 1200],
        ]);

        const md = spreadsheetToLLMText(buf);

        // Sheet heading and the row/column-letter header row.
        expect(md).toContain("## Sheet: Budget");
        expect(md).toContain("| Row | A | B |");
        // Row numbers are the leftmost column so a model can name cells as
        // Sheet!<col><row> — e.g. the value 1200 lives at B2.
        expect(md).toContain("| 1 | Item | Amount |");
        expect(md).toContain("| 2 | Rent | 1200 |");
    });

    it("escapes pipe characters so a cell value can't break the table", () => {
        const buf = makeXlsx("S1", [["a|b"]]);
        const md = spreadsheetToLLMText(buf);
        expect(md).toContain("a\\|b");
    });

    it("returns an empty string for a workbook with no used cells", () => {
        const buf = makeXlsx("Empty", [[]]);
        expect(spreadsheetToLLMText(buf)).toBe("");
    });
});
