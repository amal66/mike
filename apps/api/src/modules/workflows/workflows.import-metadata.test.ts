import { describe, expect, it } from "vitest";
import { importWorkflow } from "./workflows.service";

function database() {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe("workflows");
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return {
            select() {
              return {
                single: async () => ({
                  data: { id: "wf-1", ...row },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
  return { db: db as Parameters<typeof importWorkflow>[0], inserts };
}

describe("workflow import metadata", () => {
  it("stores explicit language and jurisdictions", async () => {
    const { db, inserts } = database();
    const result = await importWorkflow(db, {
      userId: "user-1",
      body: {
        formatVersion: 1,
        workflow: {
          title: "Cross-border review",
          type: "assistant",
          language: "French",
          jurisdictions: ["France"],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(inserts[0]).toMatchObject({
      language: "French",
      jurisdictions: ["France"],
    });
  });

  it("applies stable defaults to legacy version-one packs", async () => {
    const { db, inserts } = database();
    await importWorkflow(db, {
      userId: "user-1",
      body: {
        formatVersion: 1,
        workflow: { title: "Legacy review", type: "assistant" },
      },
    });

    expect(inserts[0]).toMatchObject({
      language: "English",
      jurisdictions: ["General"],
    });
  });
});
