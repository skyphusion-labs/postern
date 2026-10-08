// #651 (from #632 F12): `field` applies to mode "substr" ONLY, and the tool's own
// description has always said so. The result nevertheless echoed `field: field ?? null`
// unconditionally, so `mode: hybrid, field: subject` came back carrying
// `field: "subject"`. An echo is how a caller checks a parameter was understood, so
// that echo read as confirmation the search had been restricted to subjects when it
// had not been, and the caller had no other way to tell.
//
// The answer here is REFUSAL, not a quieter echo. It is the house rule this repo
// already applies to an accepted-and-ignored parameter (#632 F1 made an unknown key a
// refusal rather than a strip, and registerTools says why: a supplied filter that is
// silently dropped is worse than one that is rejected, because the caller reasonably
// believes it applied). Omitting the key would still run the unrestricted search and
// leave the caller to notice an absent key; refusing runs no search at all.
//
// So three cases, and a caller can tell all three apart:
//   substr + field      -> the search runs, `field` is echoed with the honored value
//   substr, no field    -> the search runs, `field: null` (no column named)
//   any other mode      -> no `field` key at all, and SUPPLYING one is a hard error
import { describe, expect, it, vi } from "vitest";
import { READ_TOOLS } from "../src/tools.js";
import { PosternError } from "../src/client.js";

function searchTool() {
  const t = READ_TOOLS.find((x) => x.name === "mailbox_search");
  if (!t) throw new Error("no mailbox_search tool");
  return t;
}

function clientSpy() {
  return { search: vi.fn().mockResolvedValue({ items: [], cursor: null }) } as any;
}

describe("mailbox_search field is refused outside substr mode (#651)", () => {
  // The defect, stated as the exact call from the issue. Before the fix this resolved
  // and `out.field` was "subject", which is the false confirmation.
  it("refuses mode=hybrid with field, and runs NO search", async () => {
    const client = clientSpy();
    await expect(
      searchTool().handler(client, { query: "invoice", mode: "hybrid", field: "subject" }),
    ).rejects.toThrow(/substr/);
    // The refusal has to come BEFORE the request. A search that already ran and then
    // threw would still have cost a round trip and could still have been logged as an
    // unrestricted query.
    expect(client.search).not.toHaveBeenCalled();
  });

  it("refuses the DEFAULTED mode too, where the trap is worst", async () => {
    // mode is optional and defaults to hybrid, so `{ query, field }` with no mode is
    // the most likely way a caller walks into this: it reads like "search subjects for
    // X" and silently was not.
    const client = clientSpy();
    await expect(
      searchTool().handler(client, { query: "invoice", field: "subject" }),
    ).rejects.toThrow(/substr/);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("refuses field on fts and semantic as well, not just hybrid", async () => {
    for (const mode of ["fts", "semantic"]) {
      const client = clientSpy();
      await expect(
        searchTool().handler(client, { query: "x", mode, field: "body" }),
      ).rejects.toThrow(/substr/);
      expect(client.search).not.toHaveBeenCalled();
    }
  });

  it("names both remedies in the error, and is a PosternError", async () => {
    // A refusal a caller cannot act on is only half an answer: it has to say that the
    // column selector belongs to substr and that dropping it is the other way out.
    const err = await searchTool()
      .handler(clientSpy(), { query: "x", mode: "hybrid", field: "subject" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PosternError);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/field/);
    expect(msg).toMatch(/substr/);
    expect(msg).toMatch(/remove|omit|drop/i);
  });
});

describe("mailbox_search field echo in the mode that honors it (#651)", () => {
  // The CONTROL. A fix that refused everything, or that dropped the echo wholesale,
  // would look exactly like a fix from the refusal tests alone.
  it("still forwards and echoes field in substr mode", async () => {
    const client = clientSpy();
    const out: any = await searchTool().handler(client, {
      query: "invoice",
      mode: "substr",
      field: "subject",
    });
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: "invoice", mode: "substr", field: "subject" }),
    );
    expect(out.mode).toBe("substr");
    expect(out.field).toBe("subject");
  });

  it("echoes field: null in substr mode when no column was named", async () => {
    // Still meaningful here, and different from the key being absent: in substr mode a
    // caller CAN name a column, and null says it did not.
    const client = clientSpy();
    const out: any = await searchTool().handler(client, { query: "x", mode: "substr" });
    expect(out.field).toBeNull();
    expect("field" in out).toBe(true);
  });

  it("omits the field key entirely in the modes that ignore it", async () => {
    // The two cases the caller must be able to tell apart, asserted as a pair:
    // present-with-a-value in substr, ABSENT (not null) everywhere else. A `null` here
    // would be a third reading, "understood but unrestricted", which is not true.
    for (const mode of ["hybrid", "fts", "semantic"]) {
      const out: any = await searchTool().handler(clientSpy(), { query: "x", mode });
      expect("field" in out).toBe(false);
    }
    const substr: any = await searchTool().handler(clientSpy(), { query: "x", mode: "substr", field: "text" });
    expect("field" in substr).toBe(true);
    expect(substr.field).toBe("text");
  });

  it("never sends field to the client in a non-substr mode", async () => {
    const client = clientSpy();
    await searchTool().handler(client, { query: "x", mode: "fts" });
    const sent = client.search.mock.calls[0][0];
    expect(sent.field).toBeUndefined();
  });
});

describe("mailbox_search description states the refusal (#651)", () => {
  it("says field is refused outside substr, not merely ignored", async () => {
    // #651 asks for the chosen answer to be stated where a caller reads it. "ignored by
    // other modes" was true of the old behaviour and is now WRONG, and a stale
    // description is how a caller learns the wrong contract.
    const schema: any = searchTool().inputSchema;
    const desc = String(schema.field.description ?? "");
    expect(desc).toMatch(/substr/);
    expect(desc).toMatch(/refus/i);
    expect(desc).not.toMatch(/ignored by other modes/i);
  });
});
