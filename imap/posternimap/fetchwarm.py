"""Which accessor reads a FETCH render is about to make (#457).

WHY THIS EXISTS. Twisted renders a FETCH response by calling IMessage accessors
(getHeaders, getBodyFile, getSize, getSubPart) straight from the protocol while writing
to the transport. There is no maybeDeferred seam in that path, so a body hydration that
blocks blocks the reactor, and with it every other connected client. #416 part 2 moved
every OTHER worker call into the reactor threadpool; this module is what closes the last
one.

THE SHAPE. Instead of hydrating inside the render, the door PRE-RUNS the same accessor
reads in the pool, immediately after mailbox.fetch answers and before the messages reach
Twisted. Every accessor on PosternIMAPMessage memoizes, so by the time the render calls
them they are memory reads.

WHY READS AND NOT A "does this need a body" FLAG. The lazy-hydration policy (#102: an
ENVELOPE or header scan must never fetch a body; #342: RFC822.SIZE prefers the projected
size, and a per-part BODY[i] fetches ONE attachment, not all of them) lives in
PosternIMAPMessage. A second copy of that policy here would be a second thing to keep
right, and it would be WRONG the moment it disagreed: whether BODY[HEADER.FIELDS (CC)]
can be answered from the summary depends on the individual message, not on the query. So
this module decides only WHICH accessor the render will call, with what arguments, on
which subpart -- a faithful mirror of imap4.IMAP4Server.spew_body and its siblings -- and
the message answers each one under its own existing rules.

Consequence: a query that a scan can answer from the summary produces reads that make no
worker call at all, exactly as before. FETCH UID FLAGS produces NO reads, so it does not
even take the threadpool hop.

UNKNOWN PART TYPES fall back to a whole-header read, which hydrates the message body and
can never pull attachment bytes. That is the safe direction: a part type this door has
not seen costs one message GET in the pool rather than a reactor stall.
"""

from __future__ import annotations

from typing import NamedTuple, Tuple


class Read(NamedTuple):
    """One accessor call the render will make, addressed to a subpart.

    path   -- Twisted 0-based subpart path; () addresses the message itself.
    kind   -- "size" | "headers" | "body" | "structure" | "file".
              "file" is the whole rendered message (IMessageFile.open), which is what
              a whole-message BODY[] / RFC822 fetch streams since #507.
    negate -- getHeaders negate flag ("headers" only).
    fields -- getHeaders names ("headers" only); () means the whole header block.
    """

    path: Tuple[int, ...]
    kind: str
    negate: bool = False
    fields: Tuple[str, ...] = ()


# Part types answered entirely from the list summary: getUID, getFlags,
# getInternalDate, and getEnvelope (which reads the lazy whole-header map through .get()
# on envelope names only). None of them can reach the worker, so none of them produce a
# read. Keeping this list SHORT is what preserves #102: anything not named here is
# treated as needing the message.
_PURE_SUMMARY = frozenset({"uid", "flags", "internaldate", "envelope"})

_WHOLE = ()  # the message itself, as a subpart path


def _name(field) -> str:
    if isinstance(field, (bytes, bytearray)):
        return field.decode("ascii", "replace")
    return str(field)


def _body_reads(part) -> Tuple[Read, ...]:
    """Mirror IMAP4Server.spew_body: same branch order, same accessors.

    spew_body walks part.part with getSubPart first, then dispatches on
    header / text / mime / empty / else. The walk is expressed here as the read PATH and
    performed by the message, which is the only thing that knows how a subpart index maps
    to an attachment (#342).
    """
    path = tuple(part.part or ())
    header = part.header
    if header:
        fields = tuple(_name(f) for f in (header.fields or ()))
        return (Read(path, "headers", bool(header.negate), fields),)
    if part.text:
        return (Read(path, "body"),)
    if part.mime:
        return (Read(path, "headers", True, ()),)
    if part.empty:
        if path:
            # BODY[i]: the subpart octets, which for an attachment subpart is that ONE
            # attachment (#342), never every attachment.
            return (Read(path, "body"),)
        # BODY[]: the door implements IMessageFile (#507), so spew_body streams
        # open() verbatim instead of letting MessageProducer re-serialize a parsed
        # tree. One read, and it is the read the render actually makes.
        return (Read(_WHOLE, "file"),)
    # Bare BODY: getBodyStructure.
    return (Read(path, "structure"),)


def fetch_reads(query) -> Tuple[Read, ...]:
    """The accessor reads rendering `query` will perform, in render order."""
    reads: list = []
    for part in query:
        ptype = getattr(part, "type", None)
        if ptype in _PURE_SUMMARY:
            continue
        if ptype == "rfc822size":
            # getSize prefers the cached projection (#342) and only hydrates on a miss;
            # calling it here lets it make that decision in the pool.
            reads.append(Read(_WHOLE, "size"))
        elif ptype == "rfc822header":
            reads.append(Read(_WHOLE, "headers", True, ()))
        elif ptype == "rfc822text":
            reads.append(Read(_WHOLE, "body"))
        elif ptype == "rfc822":
            # spew_rfc822 prefers IMessageFile exactly as spew_body does (#507).
            reads.append(Read(_WHOLE, "file"))
        elif ptype == "bodystructure":
            reads.append(Read(_WHOLE, "structure"))
        elif ptype == "body":
            reads.extend(_body_reads(part))
        else:
            reads.append(Read(_WHOLE, "headers", True, ()))
    return tuple(reads)
