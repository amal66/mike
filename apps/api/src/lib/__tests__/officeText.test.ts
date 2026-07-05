import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractPresentationText } from "../officeText";

/** A minimal slide XML with the given <a:t> text runs. */
function slideXml(...runs: string[]): string {
    const body = runs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("");
    return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

/** Build a tiny .pptx buffer with the given per-slide run lists. */
async function makePptx(slides: string[][]): Promise<Buffer> {
    const zip = new JSZip();
    slides.forEach((runs, i) => {
        zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(...runs));
    });
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractPresentationText", () => {
    it("extracts <a:t> runs as slide-delimited markdown in slide order", async () => {
        const buf = await makePptx([
            ["Title Slide", "Subtitle"],
            ["Second slide body"],
        ]);

        const text = await extractPresentationText(buf);

        expect(text).toContain("## Slide 1");
        expect(text).toContain("Title Slide");
        expect(text).toContain("Subtitle");
        expect(text).toContain("## Slide 2");
        expect(text).toContain("Second slide body");
        // Slide 1 must come before slide 2 (natural numeric ordering).
        expect(text.indexOf("## Slide 1")).toBeLessThan(
            text.indexOf("## Slide 2"),
        );
    });

    it("decodes XML entities in slide text", async () => {
        const buf = await makePptx([["Ben &amp; Jerry &lt;3"]]);
        const text = await extractPresentationText(buf);
        expect(text).toContain("Ben & Jerry <3");
    });

    it("returns an empty string for bytes it cannot open as a zip", async () => {
        const notAZip = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]);
        expect(await extractPresentationText(notAZip)).toBe("");
    });
});
