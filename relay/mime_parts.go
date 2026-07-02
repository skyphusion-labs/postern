package main

import "github.com/jhillyerd/enmime"

// collectMIMEParts returns every non-body MIME part a message carries, in ONE
// place so the two seams that consume it (the /ingest intake in
// buildParsedInbound and the submission path in collectAttachments) cannot drift
// on which parts survive -- the same lockstep spirit as MAX_RECIPIENTS.
//
// Policy: Attachments + Inlines + OtherParts, in that order. Inline parts (e.g.
// an Apple Mail inline image) and other parts (multipart/related extras) are
// carried so nothing is silently dropped; carrying an inline part preserves its
// BYTES (fidelity of bytes is the contract), while rendering it inline (cid)
// rather than as an attachment stays a tracked follow-up. Structural parts that
// carry no bytes (and defensive nils) are skipped: there is nothing to store.
func collectMIMEParts(env *enmime.Envelope) []*enmime.Part {
	all := make([]*enmime.Part, 0, len(env.Attachments)+len(env.Inlines)+len(env.OtherParts))
	all = append(all, env.Attachments...)
	all = append(all, env.Inlines...)
	all = append(all, env.OtherParts...)

	out := make([]*enmime.Part, 0, len(all))
	for _, part := range all {
		if part == nil || len(part.Content) == 0 {
			continue // nil or structural part with no bytes; nothing to carry
		}
		out = append(out, part)
	}
	return out
}
