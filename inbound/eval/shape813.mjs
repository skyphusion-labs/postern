// #940: the template-family key the replay uses to split known-item probes into "unique shape"
// and "repeated shape". It must equal inbound/src/semrank.ts templateKey, because that key
// decides which messages collapse (semantic) or share a family cap (hybrid).
// semrank-shape-parity.test.ts asserts the two agree; change both together.
export function shapeKey(from, subject) {
  const sender = (from ?? "").toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim();
  const subj = (subject ?? "")
    .toLowerCase()
    .replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/, "")
    .replace(/\b[0-9a-f]{7,}\b/g, "#")
    .replace(/#?\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${sender}|${subj}`;
}
