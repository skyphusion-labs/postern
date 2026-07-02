// Streaming-aware request-body reader (#196, audit F6).
//
// The Content-Length fast-reject only covers a request that DECLARES its
// length; a chunked / header-less body used to skip the in-code cap entirely
// (Cloudflare platform limits still bounded it). Here the declared length is
// fast-rejected first, then every arriving chunk is counted and the read
// aborts the moment the cap is crossed -- before the remainder is pulled or
// buffered -- so the guard holds regardless of framing.
//
// LOCKSTEP: this module is kept byte-identical in inbound/src/body.ts and
// worker/src/body.ts (one send core, two front doors; same pattern as the
// MAX_RECIPIENTS pairing between email.ts and smtp.go). Change both together.

// Thrown when the body is, or would become, larger than the cap. Callers map
// it to their own 413 shape (MailboxError in inbound, a JSON response in the
// legacy send worker).
export class PayloadTooLargeError extends Error {}

// Read the whole body as UTF-8 text, throwing PayloadTooLargeError as soon as
// more than maxBytes have arrived. An absent body reads as "" (JSON.parse then
// fails exactly like request.json() on an empty body did).
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string> {
  const declaredLen = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new PayloadTooLargeError("declared content-length over cap");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      // Stop pulling immediately; the rest of the stream is never buffered.
      await reader.cancel("body over cap");
      throw new PayloadTooLargeError("request body over cap");
    }
    chunks.push(chunk);
  }

  // Concatenate BEFORE decoding so a multi-byte character split across a chunk
  // boundary decodes correctly.
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}
