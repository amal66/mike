"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import type { Settings } from "@fortune-sheet/core";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import "@fortune-sheet/react/dist/index.css";

// Fortune-sheet renders to a <canvas> and reaches for browser globals at
// module scope, so it must never be imported during SSR. `next/dynamic` with
// `ssr: false` defers loading the <Workbook> until the component mounts in the
// browser.
const Workbook = dynamic(
    () => import("@fortune-sheet/react").then((m) => m.Workbook),
    {
        ssr: false,
        loading: () => (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
            </div>
        ),
    },
);

interface Props {
    documentId: string;
    versionId?: string | null;
    rounded?: boolean;
    bordered?: boolean;
}

/**
 * Read-only spreadsheet viewer. Unlike PDFs/DOCX, Excel files are served raw
 * by `/display` (never rendered to PDF server-side), so we fetch the bytes
 * here, convert them client-side to the Fortune-sheet JSON model with
 * `luckyexcel`, and hand the resulting sheets to a read-only `<Workbook>`.
 *
 * Props mirror the sibling viewers (DocView / DocxView): `documentId` +
 * `versionId` identify the bytes to load, `rounded`/`bordered` control the
 * frame so the assistant panel can drop the border/rounding when embedding.
 */
export function SpreadsheetView({
    documentId,
    versionId,
    rounded = true,
    bordered = true,
}: Props) {
    const { result, error } = useFetchSingleDoc(documentId, versionId);
    const [sheets, setSheets] = useState<Settings["data"] | null>(null);
    const [convertError, setConvertError] = useState<string | null>(null);

    useEffect(() => {
        if (!result || result.type !== "spreadsheet") return;
        let cancelled = false;
        setSheets(null);
        setConvertError(null);

        (async () => {
            try {
                // Import luckyexcel lazily so its browser-only code never runs
                // during SSR (this file is a client component, but the module
                // graph is still evaluated on the server).
                const { default: LuckyExcel } = await import("luckyexcel");
                const blob = new Blob([result.buffer], {
                    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                });
                LuckyExcel.transformExcelToLucky(blob, (exportJson) => {
                    if (cancelled) return;
                    if (!exportJson?.sheets?.length) {
                        setConvertError("This spreadsheet has no sheets.");
                        return;
                    }
                    // luckyexcel emits the same sheet shape Fortune-sheet
                    // consumes; the declared types differ, so cast across.
                    setSheets(exportJson.sheets as unknown as Settings["data"]);
                });
            } catch {
                if (!cancelled) setConvertError("Failed to load spreadsheet.");
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [result]);

    const frameClass = `relative flex flex-col flex-1 overflow-hidden bg-white ${
        bordered ? "border border-gray-200" : ""
    } ${rounded ? "rounded-lg" : ""}`;

    const message = error ?? convertError;

    return (
        <div className={frameClass}>
            {message ? (
                <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-red-500">{message}</p>
                </div>
            ) : !sheets ? (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            ) : (
                // Fortune-sheet fills its parent, so the wrapper must be a
                // positioned, sized box. Read-only: editing, the toolbar and
                // the formula bar are all disabled; sheet tabs stay so users
                // can switch between worksheets.
                <div className="relative flex-1 min-h-0">
                    <Workbook
                        data={sheets}
                        allowEdit={false}
                        showToolbar={false}
                        showFormulaBar={false}
                        showSheetTabs
                    />
                </div>
            )}
        </div>
    );
}
