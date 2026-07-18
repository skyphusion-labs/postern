// Canonical RFC822 projection (#342). Byte-length identical to
// imap/posternimap/rfc822.py render_rfc822 / project_rfc822_size. Deterministic
// MIME boundaries (sha256(message_id + NUL + path)) make a length from D1
// metadata match live BODY[].

export const PROJECTION_VERSION = 1;

export interface ProjectAttachment {
  filename: string | null;
  mime: string | null;
  size: number;
}

export interface ProjectInput {
  messageId: string;
  from?: string | null;
  to?: string | null;
  subject?: string;
  date?: string;
  inReplyTo?: string | null;
  cc?: string | null;
  bcc?: string | null;
  sender?: string | null;
  replyTo?: string | null;
  bodyText?: string;
  bodyHtml?: string | null;
  attachments?: ProjectAttachment[];
}

const NL = "\n";
const te = new TextEncoder();

function hdr(value: string): string {
  return value.replace(/\r/g, " ").replace(/\n/g, " ");
}

function angle(value: string): string {
  const v = value.trim();
  if (v.startsWith("<") && v.endsWith(">")) return v;
  return `<${v}>`;
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return false;
  }
  return true;
}

function b64Word(value: string): string {
  const bytes = te.encode(value);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `=?utf-8?b?${btoa(bin)}?=`;
}

function encodeHeaderValue(value: string): string {
  const v = hdr(value);
  if (isAscii(v)) return v;
  // Match email.header.Header(..., 'utf-8').encode() for unstructured fields.
  return b64Word(v);
}

function encodeAddressHeader(value: string): string {
  const v = hdr(value);
  if (isAscii(v)) return v;
  // Match parseaddr + Header(name).encode() + formataddr (addr-spec stays ASCII).
  const m = v.match(/^(.*)<([^<>]+)>\s*$/);
  if (m) {
    const name = (m[1] || "").trim().replace(/^"|"$/g, "");
    const addr = m[2]!.trim();
    if (!name) return addr;
    return `${b64Word(name)} <${addr}>`;
  }
  return b64Word(v);
}

/** Match email.utils.format_datetime for UTC-aware ISO inputs. */
export function fmtDate(iso: string): string {
  if (!iso) return "";
  const normalized = iso.endsWith("Z") ? iso.slice(0, -1) + "+00:00" : iso;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Python %a / format_datetime weekday: Mon=0 in calendar.weekday; JS getUTCDay Sun=0.
  const pyWeekday = (d.getUTCDay() + 6) % 7; // Mon=0
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dd = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  // format_datetime omits leading zero on day-of-month.
  return `${days[pyWeekday]}, ${dd} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm}:${ss} +0000`;
}

async function boundaryToken(messageId: string, path: string): Promise<string> {
  const data = te.encode(`${messageId}\0${path}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `b${hex.slice(0, 32)}`;
}

function splitMime(mime: string | null | undefined): [string, string] {
  if (!mime) return ["application", "octet-stream"];
  const slash = mime.indexOf("/");
  if (slash < 0) return ["application", mime];
  const main = mime.slice(0, slash) || "application";
  const rest = mime.slice(slash + 1);
  return [main, (rest.split(";", 1)[0] || "octet-stream").trim()];
}

function mimeFromFilename(filename: string | null | undefined): string | null {
  if (!filename || !filename.includes(".")) return null;
  const ext = filename.split(".").pop()!.toLowerCase();
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    txt: "text/plain",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    gz: "application/gzip",
    zip: "application/zip",
  };
  return byExt[ext] ?? null;
}

function ensureTrailingNl(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function u(s: string): Uint8Array {
  return te.encode(s);
}

function cat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function quoteFilename(name: string): string {
  return hdr(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function base64Wire(size: number): Uint8Array {
  const raw = new Uint8Array(Math.max(0, size | 0));
  let b64 = "";
  const chunk = 0x8000;
  for (let i = 0; i < raw.length; i += chunk) {
    const slice = raw.subarray(i, Math.min(i + chunk, raw.length));
    let bin = "";
    for (let j = 0; j < slice.length; j++) bin += String.fromCharCode(slice[j]!);
    b64 += btoa(bin);
  }
  if (!b64) return u(NL);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return u(lines.join("\n") + "\n");
}

function envelopeHeaderBlock(input: ProjectInput): string[] {
  const lines: string[] = [];
  if (input.from) lines.push(`From: ${encodeAddressHeader(input.from)}`);
  if (input.to) lines.push(`To: ${encodeAddressHeader(input.to)}`);
  if (input.cc) lines.push(`Cc: ${encodeAddressHeader(input.cc)}`);
  if (input.bcc) lines.push(`Bcc: ${encodeAddressHeader(input.bcc)}`);
  if (input.sender) lines.push(`Sender: ${encodeAddressHeader(input.sender)}`);
  if (input.replyTo) lines.push(`Reply-To: ${encodeAddressHeader(input.replyTo)}`);
  lines.push(`Subject: ${encodeHeaderValue(input.subject || "")}`);
  const date = fmtDate(input.date || "");
  if (date) lines.push(`Date: ${date}`);
  if (input.messageId) lines.push(`Message-ID: ${encodeHeaderValue(angle(input.messageId))}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${encodeHeaderValue(angle(input.inReplyTo))}`);
  lines.push("MIME-Version: 1.0");
  return lines;
}

function partHeaders(headers: string[], body: Uint8Array): Uint8Array {
  return cat([u(headers.join(NL) + NL + NL), body]);
}

function textBody(text: string): Uint8Array {
  return u(ensureTrailingNl(text));
}

function wrapMultipart(boundary: string, parts: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(u(`--${boundary}${NL}`));
    chunks.push(part);
    if (part.length === 0 || part[part.length - 1] !== 0x0a) chunks.push(u(NL));
  }
  chunks.push(u(`--${boundary}--${NL}`));
  return cat(chunks);
}

async function buildAlternative(mid: string, path: string, plain: string, html: string): Promise<Uint8Array> {
  const boundary = await boundaryToken(mid, path);
  const parts = [
    partHeaders(
      ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit"],
      textBody(plain),
    ),
    partHeaders(
      [
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: 8bit",
        "MIME-Version: 1.0",
      ],
      textBody(html),
    ),
  ];
  return partHeaders(
    [`Content-Type: multipart/alternative; boundary="${boundary}"`],
    wrapMultipart(boundary, parts),
  );
}

function buildAttachment(att: ProjectAttachment): Uint8Array {
  const filename = att.filename || "attachment";
  const mime = att.mime || mimeFromFilename(att.filename) || "application/octet-stream";
  const [main, sub] = splitMime(mime);
  const q = quoteFilename(filename);
  return partHeaders(
    [
      `Content-Type: ${main}/${sub}; name="${q}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${q}"`,
      "MIME-Version: 1.0",
    ],
    base64Wire(att.size),
  );
}

/** Full projected RFC822 bytes (zero placeholders for attachment payloads). */
export async function renderRfc822Projection(input: ProjectInput): Promise<Uint8Array> {
  const mid = input.messageId || "unknown";
  const html = (input.bodyHtml || "").trim();
  const plain = input.bodyText || "";
  const atts = input.attachments ?? [];
  const env = envelopeHeaderBlock(input);

  if (atts.length === 0 && !html) {
    env.push('Content-Type: text/plain; charset="utf-8"');
    env.push("Content-Transfer-Encoding: 8bit");
    return cat([u(env.join(NL) + NL + NL), textBody(plain)]);
  }

  if (atts.length === 0 && html) {
    const boundary = await boundaryToken(mid, "0");
    env.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      partHeaders(
        ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit"],
        textBody(plain),
      ),
      partHeaders(
        [
          'Content-Type: text/html; charset="utf-8"',
          "Content-Transfer-Encoding: 8bit",
          "MIME-Version: 1.0",
        ],
        textBody(html),
      ),
    ];
    return cat([u(env.join(NL) + NL + NL), wrapMultipart(boundary, parts)]);
  }

  // multipart/mixed root
  const boundary = await boundaryToken(mid, "0");
  env.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  let first: Uint8Array;
  if (html) {
    first = await buildAlternative(mid, "0.0", plain, html);
  } else {
    first = partHeaders(
      ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit"],
      textBody(plain),
    );
  }
  const parts = [first, ...atts.map(buildAttachment)];
  return cat([u(env.join(NL) + NL + NL), wrapMultipart(boundary, parts)]);
}

/** Projected RFC822 byte length for SIZE / D1 cache. */
export async function projectRfc822Size(input: ProjectInput): Promise<number> {
  return (await renderRfc822Projection(input)).byteLength;
}
