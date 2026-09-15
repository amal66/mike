import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  createDocumentVersion,
  createDocumentVersions,
  activateDocumentVersion,
  updateDocumentVersion,
} from "../documents.lifecycle";

describe("document version persistence boundary", () => {
  it("passes stable identity and metadata to the atomic create operation", async () => {
    const row = { id: "v", version_number: 3 };
    const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
    const db = { rpc } as unknown as Db;
    expect(
      await createDocumentVersion(db, {
        document_id: "doc",
        id: "v",
        storage_path: "new/key",
        source: "user_upload",
        filename: "Clause.docx",
      }),
    ).toEqual({ data: row, error: null });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_document_version", {
      p_document_id: "doc",
      p_version: {
        id: "v",
        storage_path: "new/key",
        source: "user_upload",
        filename: "Clause.docx",
      },
      p_activate: true,
    });
    // Number allocation belongs to the transaction, not a preceding SELECT.
    expect(rpc.mock.calls[0][1].p_version).not.toHaveProperty("version_number");
  });

  it("can defer activation until dependent edit rows have been recorded", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "v" }, error: null });
    await createDocumentVersion(
      { rpc } as unknown as Db,
      {
        document_id: "doc",
        storage_path: "key",
        source: "assistant_edit",
        filename: "Draft.docx",
      },
      { activate: false },
    );
    expect(rpc.mock.calls[0][1].p_activate).toBe(false);
  });

  it("does not hide a transactional insertion failure", async () => {
    const error = { code: "23505", message: "identity conflict" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error });
    const versions = [
      {
        document_id: "doc",
        storage_path: "key",
        source: "upload",
        filename: "Draft.pdf",
      },
    ];
    expect(
      await createDocumentVersions({ rpc } as unknown as Db, versions),
    ).toEqual({ data: null, error });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_document_versions", {
      p_versions: versions,
    });
  });

  it.each([false, null])(
    "rejects a stale activation result: %s",
    async (data) => {
      const rpc = vi.fn().mockResolvedValue({ data, error: null });
      expect(
        await activateDocumentVersion({ rpc } as unknown as Db, "doc", "v"),
      ).toEqual({ activated: false, error: null });
      expect(rpc).toHaveBeenCalledWith("activate_document_version", {
        p_document_id: "doc",
        p_version_id: "v",
      });
    },
  );

  it("replacement repeats the document boundary and excludes tombstones", async () => {
    const fake = scriptedDb([
      { table: "document_versions", op: "update", data: { id: "v" } },
    ]);
    await updateDocumentVersion(fake.db, "doc", "v", {
      storage_path: "new/key",
      pdf_storage_path: null,
    });
    expect(fake.calls[0].filters).toEqual([
      ["eq", "id", "v"],
      ["eq", "document_id", "doc"],
      ["is", "deleted_at", null],
    ]);
    fake.done();
  });
});
