// #950 candidate embed recipes. EVAL ONLY: nothing here ships until one is chosen at the design
// gate, and then it moves into src/embedtext.ts as EMBED_VERSION 3. Each is a pure function
// (subject, body) => chunk texts, built on the shipped recipe (embedChunks v2), so a candidate
// differs from what ships by exactly its own change.
//
//   R2      what ships: chunk 0 is "Subject: <subject>" then the first 1200 body chars.
//   R3a     + a subject-only chunk ahead of R2. One more vector per message that has a body.
//   R3b     R2 on a body with the signature footer cut (a line "--" or "-- ", RFC 3676) and
//           link-only lines dropped (a line whose non-URL text is at most 40 chars). Generic:
//           it names no sender.
//   R3c     R3a and R3b together.
import { embedChunks, SUBJECT_CAP } from "../src/embedtext.ts";

const subjectOf = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_CAP);

export function stripBoilerplate(body) {
  const out = [];
  for (const line of String(body ?? "").split("\n")) {
    if (/^--\s?$/.test(line)) break; // the signature delimiter: everything after is footer
    const urls = line.match(/https?:\/\/\S+/g);
    if (urls) {
      const rest = line.replace(/https?:\/\/\S+/g, "").trim();
      if (rest.length <= 40) continue; // a link line ("View workflow run: <url>")
    }
    out.push(line);
  }
  return out.join("\n");
}

function withSubjectChunk(subject, chunks) {
  const s = subjectOf(subject);
  const head = `Subject: ${s}`;
  if (!s || chunks.length === 0 || chunks[0] === head) return chunks;
  return [head, ...chunks];
}

export const RECIPES950 = {
  R2: (subject, body) => embedChunks(subject, body, 2),
  R3a: (subject, body) => withSubjectChunk(subject, embedChunks(subject, body, 2)),
  R3b: (subject, body) => embedChunks(subject, stripBoilerplate(body), 2),
  R3c: (subject, body) => withSubjectChunk(subject, embedChunks(subject, stripBoilerplate(body), 2)),
};
