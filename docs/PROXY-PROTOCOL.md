# PROXY protocol contract (the mail-edge doors)

Status: normative. This document is the single contract for how a postern mail
door recovers the real client IP when it sits behind an L4 load balancer that
speaks the PROXY protocol. It is implementation-agnostic: the Go 587 submission
door and the Python 993 IMAP door both implement THIS document, with identical
config names, so an operator sets one mental model and one set of values for both.

Issue: #155. Companion code: `relay/proxyproto.go` (Go 587), the equivalent in
`imap/` (Python 993).

## 1. Why this exists

The postern mail edge moved to a single L4 load balancer that targets
the directory host DIRECTLY (no bastion, no HAProxy middle layer). An L4 load balancer
forwards the TCP stream but rewrites the source address, so without help every
connection would appear to originate from the load balancer's own private
address. The throttle (#105) and the logs would then see one IP for the whole
world.

The load balancer is configured to PROXY-protocol the connections: it prepends a
small header carrying the ORIGINAL client address (and the original destination)
ahead of the real byte stream. Each door reads that header off the front of the
connection, before any TLS handshake or protocol greeting, and uses it as the
connection's remote address.

## 2. Trust model (the security-critical property)

A PROXY header is a claim about who the client is. Anyone who can open a TCP
connection to the door can WRITE a PROXY header. Therefore:

> A PROXY header is honored ONLY when the connection's immediate peer (the raw
> TCP source address of the socket) is inside a configured trusted set. A header
> from ANY untrusted peer is NEVER honored.

This is the entire anti-spoof guarantee. The trusted set is the load balancer's
private source address(es). A forged header from an untrusted peer must not be
able to:

- poison the per-account throttle (#105) or any future per-IP control, or
- forge a log line that frames an innocent IP.

The trust decision is made on the RAW socket peer and is evaluated BEFORE a
single header byte is interpreted. When the peer is untrusted the door does not
consume any bytes as a header: a forged header is left in the stream where the
normal protocol parser (SMTP command parser / IMAP command parser) rejects it as
garbage.

## 3. Configuration (identical names on both doors)

| Variable | Values | Default | Meaning |
| --- | --- | --- | --- |
| `PROXY_PROTOCOL` | `off` \| `optional` \| `require` | `off` | Header-handling mode (section 4). |
| `PROXY_PROTOCOL_TRUSTED` | comma-separated CIDR list | (empty) | The trusted proxy source(s). A bare IP is accepted as `/32` (IPv4) or `/128` (IPv6). |
| `PROXY_PROTOCOL_TIMEOUT_SECONDS` | integer seconds | `5` | Bound on reading the header from a trusted peer (section 7). Floored at 1s. |

Validation (fail at startup, not on first connection):

- An unknown `PROXY_PROTOCOL` value is a config error.
- When `PROXY_PROTOCOL` is `optional` or `require`, `PROXY_PROTOCOL_TRUSTED` MUST
  contain at least one CIDR. An enabled door with no trusted source could honor no
  header at all (`require` would reject everything; `optional` would never honor),
  which is always a misconfiguration.
- A malformed CIDR is a config error.

Default `off` is correct for mesh-internal / dev direct connections (no load
balancer in front), and is byte-for-byte the prior behavior: the listener is not
wrapped at all.

## 4. Behavior matrix

The two axes are the connection's mode and whether the immediate peer is trusted.
"Real client IP" means the address carried in the PROXY header; "raw peer" means
the immediate socket source address.

| Mode | Peer | PROXY header present? | Outcome |
| --- | --- | --- | --- |
| `off` | any | (not read) | Raw peer. Header, if any, is left in the stream and the protocol parser handles it. |
| `optional` | trusted | yes (valid) | Real client IP. |
| `optional` | trusted | no | Raw peer (fall back). |
| `optional` | trusted | yes (malformed) | Reject the connection (section 6). |
| `optional` | untrusted | (not honored) | Raw peer. Any header bytes are left in the stream; the protocol parser rejects them. |
| `require` | trusted | yes (valid) | Real client IP. |
| `require` | trusted | no | Reject the connection. |
| `require` | trusted | yes (malformed) | Reject the connection. |
| `require` | untrusted | (not honored) | Reject the connection. |

Notes:

- `require` is the production posture once the load balancer is live: every
  connection is expected to arrive via the trusted proxy carrying a header. A
  trusted peer that sends no header, and any untrusted peer, are rejected.
- `optional` is the migration / mixed posture: a trusted proxy MAY prepend a
  header; a trusted client connecting directly (no header) still works, falling
  back to its raw peer address. See the latency note in section 7.
- "Reject the connection" means the door drops the connection without serving
  the protocol. It is a connection-level refusal, not a protocol-level error
  reply. The EXPECTED operational rejects (an untrusted peer; a trusted peer with
  no header in `require` mode, e.g. the LB's bare-TCP health check) are a CLEAN
  drop: the connection is closed quietly, NOT logged as an error and NOT counted
  toward any throttle (the reject happens before the auth code, so it can never
  reach #105). A diagnostic line is emitted only under the door's debug switch.
  The one LOUD reject is a malformed header from a trusted peer (section 6): a
  real protocol fault from the LB, surfaced to the operator.

## 5. Deploy ordering (HARD) and health checks

### 5.1 Cutover sequence

This ordering is a HARD operational constraint, not a preference. The load
balancer makes the service INACCESSIBLE if it has the proxy-protocol flag enabled
while the target is not yet parsing it (the LB prepends a header the door does not
understand, the door treats it as a malformed greeting, and every connection
fails). Therefore:

1. **Deploy BOTH doors with `PROXY_PROTOCOL=optional` first.** Optional is the
   migration-safe mode that bridges the cutover: it parses a header if one is
   present, and falls back to the raw peer IP if one is absent. So the door works
   correctly BOTH before the LB flag is on (no header yet -> raw peer) AND after
   (header present -> real client). This is what makes the flip safe.
2. **THEN enable the proxy-protocol flag at the load balancer.** Now every
   connection carries a header; the doors, already in optional, honor it.
3. **(Optional, later) tighten the doors to `PROXY_PROTOCOL=require`** once the LB
   is the proven SOLE ingress. Require rejects any connection that does not arrive
   through the trusted proxy with a header; do this only after step 2 is verified
   stable, because require depends on the header always being present.

> The REVERSE order is the outage. Enabling the LB flag BEFORE the doors parse the
> header (or jumping straight to `require` before the LB sends headers) takes the
> service down. `optional` is the bridge; never flip the LB against an off/require
> door that is not yet receiving the headers it expects.

The same sequence governs both doors (587 Go submission, 993 Python IMAP), the
fleet-chezmoi LB IaC, and the GO-LIVE runbook; they all reference THIS section.

### 5.2 Bind surface

Each door binds the PRIVATE VLAN address only (e.g. the 587 door on
`192.0.2.10:587`), never `0.0.0.0` and never a public bind. The directory host stays
dark; the load balancer is the only public surface, and the host firewall admits
the door's port only FROM the LB's private source (the estate `192.0.2.0/24`). The trusted set
in `PROXY_PROTOCOL_TRUSTED` is that same LB private source.

### 5.3 Health checks

The load balancer health check is a BARE TCP connect with NO PROXY header. This is
handled benignly by construction:

- The TCP connection is accepted at the socket layer (so a TCP-level health check
  sees the port as healthy) before any header handling runs.
- In `optional` mode (the cutover/steady mode of 5.1 step 1-2) a headerless
  connection falls back to the raw peer and is served normally; a bare connect
  that sends no command simply disconnects. It never issues an AUTH, so it never
  reaches the #105 throttle and is never logged as an auth failure.
- In `require` mode a headerless connection from the trusted LB source is a CLEAN
  drop (section 4): closed quietly, not logged as an error, not throttled. So the
  probes do not pollute logs or the throttle even under require.

Use a TCP-level health check. On the STARTTLS door (587) a clean drop is silent at
the application layer; on an implicit-TLS door (465) a bare-TCP probe never
completes the TLS handshake, so a TCP check (not an application check) is required
there regardless of PROXY protocol.

## 6. Header parsing (what "valid" means)

Both PROXY protocol versions defined by the HAProxy specification are accepted;
the door auto-detects which one is present.

### v1 (human-readable text)

A single CRLF-terminated line, at most 107 bytes:

```
PROXY TCP4 <src-ip> <dst-ip> <src-port> <dst-port>\r\n
PROXY TCP6 <src-ip> <dst-ip> <src-port> <dst-port>\r\n
PROXY UNKNOWN ...\r\n
```

- `TCP4` / `TCP6`: the source address/port is the real client. Honored.
- `UNKNOWN`: a valid header that carries no usable address (the proxy could not
  determine it). Treated as "present but no client address": the door keeps the
  raw peer. This is NOT a rejection.
- A line that is not CRLF-terminated within the byte bound, has the wrong field
  count, or has an unparseable IP/port, is MALFORMED (section 4 "malformed").

### v2 (binary)

A 12-byte signature (`\r\n\r\n\0\r\nQUIT\n`), then a 4-byte fixed header
(version+command, family+transport, and a 16-bit address-block length), then the
address block.

- Version nibble must be `2`.
- Command `PROXY` (`0x1`) with family `AF_INET`/`AF_INET6` and transport `STREAM`
  carries the real TCP client; honored.
- Command `LOCAL` (`0x0`) is the proxy's own connection (e.g. a health check);
  the address block is ignored and the door keeps the raw peer. Not a rejection.
- Any other family/transport (UDP, `AF_UNIX`, `UNSPEC`) is a valid header with no
  usable TCP client address: keep the raw peer.
- A truncated header, a bad version, or an address block shorter than the family
  requires, is MALFORMED.

A malformed header FROM A TRUSTED PEER is a hard failure (the load balancer is
expected to speak the protocol correctly, so corrupt framing is a real fault, not
something to paper over): reject the connection. This is the only place the door
fails loud on header content; everything else degrades to the raw peer.

### No header vs. truncated header (the boundary)

"No header" and "truncated header" are distinguished by the SIGNATURE, and the
distinction is the full v1 prefix (`PROXY`, 5 bytes) or the full v2 signature
(12 bytes):

- If the timeout (section 7) fires WITHOUT a complete signature having arrived
  (the peer sent nothing, or only a partial/non-matching prefix), that is NO
  HEADER: optional falls back to the raw peer, require rejects (a clean drop). A
  trusted peer that sends a non-PROXY command (e.g. `EHLO`) is also "no header"
  and is served normally in optional.
- Once a COMPLETE signature has arrived, the peer has COMMITTED to a header. If the
  remainder is then incomplete (a stall mid-header that trips the timeout, or a
  v1 line with no CRLF in bound, or a v2 address block shorter than declared), that
  is a TRUNCATED = MALFORMED header, and it is REJECTED in BOTH optional and
  require (it is no longer "silence"). Both doors implement this identical boundary:
  reject-on-incomplete fires only after the signature has matched.

## 7. The optional-mode latency note (server-speaks-first)

SMTP and IMAP are both server-speaks-first: the server sends a greeting and the
client stays silent until it arrives. The PROXY protocol is the inverse: the
sender prepends the header IMMEDIATELY on connect, before anything else.

In `require` mode there is no tension: a header is always present, so its bytes
arrive immediately and are read without delay. In `off` mode nothing is read.

In `optional` mode a trusted peer MAY or MAY NOT send a header. If it does, the
bytes are there at once. If it does not (a direct trusted client), the client is
waiting for the greeting and sends nothing, so the door cannot tell "no header"
from "header not yet arrived" except by waiting. It waits up to
`PROXY_PROTOCOL_TIMEOUT_SECONDS`, then treats the silence (no complete PROXY
signature, per section 6) as "no header" and falls back to the raw peer (and
finally sends its greeting). So a no-header connection
in `optional` mode pays up to the timeout in added latency before its greeting.
This is inherent to optional + server-speaks-first; production uses `require`
(header always present) and pays no such penalty.

The timeout also bounds a trusted peer that connects and then stalls, so a slow
or silent peer cannot pin a connection while the door waits for a header.

## 8. How the recovered IP is used

- It becomes the connection's remote address for ALL logging on that connection,
  so logs name the true client, not the load balancer.
- It is the key context any future per-IP control would use.
- It does NOT change the #105 throttle keying. #105 stays PER-ACCOUNT as designed
  (keyed on the presented login, enumeration-safe). PROXY protocol restores an
  accurate remote IP for logs and leaves the per-account throttle exactly as is.
  Per-IP control is a possible future layer that this accurate IP now enables; it
  is not part of this contract.
- The PROXY layer sits entirely BEFORE the auth code: header handling (including
  every reject in section 4) happens on the raw connection before a single SMTP/
  IMAP command is processed. So a health-check probe, an untrusted peer, or a
  spoofed header can never reach the auth path and therefore can never touch the
  #105 throttle.

## 9. Header reading happens off the accept path

A door MUST NOT read the header inside its accept loop: a slow or silent peer
would otherwise stall acceptance of every other connection. The header is read
lazily, in the per-connection context, on the connection's first use. The Go door
implements this by deferring the parse to the first `Read`/`RemoteAddr` of the
wrapped connection (guarded so it happens exactly once); the Python door achieves
the equivalent in its own connection setup. Either way, one stalled peer affects
only its own connection.
