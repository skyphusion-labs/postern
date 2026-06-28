# postern-imap Stage-1 measurement

The read-path measurement layer for the IMAP proxy: `GO-LIVE.md` step 0.6 / #102
Stage 1. It is **additive and behaviour-neutral** instrumentation that lets us
validate the Stage-1 read path (windowing, lazy hydration, the live-refresh poll,
and the `UID == messages.id` model) against the live store, once migration 0005
makes that rowid a never-reused `AUTOINCREMENT` key. This is measurement only; it
changes nothing a client sees.

The implementation is `posternimap/measure.py` (the `Meter`), wired into
`client.py`, `mailbox.py`, and `message.py`, and switched on by one config flag.

## The toggle

| | |
|---|---|
| **Env var** | `POSTERN_IMAP_MEASURE` |
| **Type / default** | boolean, **`false`** (OFF) |
| **Truthy values** | `1`, `true`, `yes`, `on` (same parser as every other proxy bool) |
| **Set it in** | `/etc/postern-imap.env` (the unit's `EnvironmentFile`), then `systemctl restart postern-imap` |

**OFF is the production default and is a true no-op.** When the flag is off, every
measurement hook short-circuits before any clock read, JSON encode, or log call, and
allocates nothing, so the read path is byte-for-byte the un-instrumented path. The
proxy never needs the flag on to function; it is a diagnostic you enable for a
measurement window and turn back off.

## The sink

Each measurement is **one structured line on the Twisted log**, which the
`postern-imap.service` unit (`Type=simple`, no redirection) sends to **journald**.
No new file, socket, or dependency. The line format is the house GMCP-style
state-channel shape, made to be parsed, not read:

```
@measure <event> {"<field>":<value>,...}
```

- The JSON object has **sorted keys** and compact separators, so a line is stable
  and diffable, and `timed` events always carry an `elapsed_ms` field.
- Every line is tagged `system="postern-imap"`.
- The payload is **counts, sizes, and timings only**. It never contains message
  content, addresses, subjects, a UID-to-content mapping, or a token. (A test
  asserts the token never appears in a measurement line.)

Read them off the box with:

```bash
journalctl -u postern-imap -o cat | grep '@measure '
# one event type:
journalctl -u postern-imap -o cat | grep '@measure cold_sync '
```

The proxy logs through Twisted's legacy observer, so each journald line is
PREFIXED (`<ts> [postern-imap] @measure <event> {json}`); the `@measure` token is
NOT at column 0. Grep for `@measure` unanchored (no `^`), or real lines are
silently missed -- which reads as a false "channel is silent."

Assert on the JSON (the machine-readable channel), not on prose.

## Event catalogue

### `@measure cold_sync` -- SELECT cold-sync cost + window saturation

Emitted once per `_ensure_loaded` (a SELECT that actually hits the API; the empty
placeholder folders never emit). Answers "what does a cold SELECT cost, and is
`POSTERN_IMAP_WINDOW=500` the right floor."

| field | meaning |
|---|---|
| `direction` | `inbound` (INBOX), `outbound` (Sent), or `all` (the All folder) |
| `pages` | number of `/api/messages` pages walked to drain the cursor |
| `collected` | total summaries pulled from the store for this view |
| `presented` | summaries kept after the window cap (== `collected` when not windowed) |
| `window` | the configured cap in effect (0 = unlimited; All is always 0) |
| `windowed` | `true` when the cap truncated this view (`collected > window`) |
| `newest_uid` | highest UID (store rowid) in the snapshot |
| `elapsed_ms` | wall-clock for the whole paged load + sort |

### `@measure api_request` -- per-request Postern API latency

Emitted once per HTTP round-trip to the worker (the single `_get` choke point, so it
covers list, message, thread, search, and ping). Answers "what does the
blocking-urllib I/O model cost per call."

| field | meaning |
|---|---|
| `path` | the API path (e.g. `/api/messages`), never a token or query secret |
| `status` | HTTP status from the transport (absent if the transport raised) |
| `bytes` | response body size in bytes |
| `elapsed_ms` | wall-clock for the transport round-trip |

On a transport error the line is still emitted (latency-to-failure) without
`status`/`bytes`.

### `@measure poll_refresh` -- live-refresh poll reactor stall

Emitted once per poll tick while a mailbox is selected (`POSTERN_IMAP_POLL_SECONDS`).
The poll runs blocking urllib in the reactor thread, so `elapsed_ms` **is** the
per-tick reactor stall. Answers the config note that "a `deferToThread` variant is a
clean follow-up if measurement shows reactor stalls under concurrent SELECTs."

| field | meaning |
|---|---|
| `direction` | the polled view (`inbound` / `outbound` / `all`) |
| `added` | new arrivals merged this tick (0 on a quiet tick) |
| `listeners` | live listeners the EXISTS would push to |
| `elapsed_ms` | wall-clock the poll held the reactor thread |

### `@measure hydrate` -- lazy body hydration

Emitted once per body **actually fetched** (`PosternIMAPMessage._hydrate`). The
point of #102 is that an ENVELOPE / header-field scan stays body-free, so a
`FETCH 1:* ENVELOPE` over the window emits **zero** `hydrate` lines; opening a
message emits exactly one. Answers "is lazy hydration actually lazy."

| field | meaning |
|---|---|
| `uid` | the message UID (store rowid); no content, just the id |
| `bytes` | size of the rendered RFC822 message |
| `placeholder` | `true` if the per-message GET missed and a summary stub was rendered |
| `elapsed_ms` | wall-clock for the GET + render + parse |

## Acceptance (GO-LIVE step 0.6 smoke)

With `POSTERN_IMAP_MEASURE=on` and migration 0005 applied (stable, never-reused
UIDs), a loopback IMAP session must show all of the following, with **no errors in
the proxy log**:

1. **Metrics populate.** A `SELECT INBOX` emits one `cold_sync` and its
   `api_request` lines; a body fetch emits one `hydrate`; an idle selected session
   emits a `poll_refresh` per interval. (`journalctl ... | grep '@measure'` is
   non-empty and well-formed JSON.)
2. **Lazy hydration holds.** A `FETCH 1:* (ENVELOPE FLAGS INTERNALDATE)` over the
   window emits **zero** `hydrate` lines (and the upstream worker logs zero
   `/api/messages/{id}` GETs for it). Opening a single message emits exactly one.
3. **Window behaves.** On INBOX/Sent, `cold_sync.presented <= window` and
   `presented == min(collected, 500)`; `windowed` is `true` only when the mailbox
   exceeds the cap. The All folder reports `window: 0` and never truncates.
4. **UID stability across reconnect.** Across a disconnect/reconnect (a fresh
   snapshot), a given message keeps the same UID and `newest_uid` only ever grows.
   This is the property 0005 guarantees (the rowid is never reused after a delete);
   it is why 0.6 runs **after** 0.5.
5. **Off is silent.** With the flag unset/`false`, a full session emits **no**
   `@measure` lines (the no-behaviour-change default).

Tuning signals the window may surface: many sessions with `windowed: true` (real
mailboxes routinely exceed 500 -> consider raising the window or the
message-size-aware follow-up); `poll_refresh.elapsed_ms` large under concurrent
SELECTs (-> the `deferToThread` follow-up the config note flags).

## Post-deploy emit-sanity gate (deploy-mechanism-agnostic)

The layer only emits if the RUNNING process is actually a build that carries it
(#102+). Whatever the deploy mechanism -- host venv, a container image, a future
`console_script` entrypoint -- a freshly-set `POSTERN_IMAP_MEASURE=on` is silently
inert if the loaded code predates #102, and repo CI cannot see a stale deploy. (The
0.6 go-live hit exactly this: the box ran pre-#102 source while the venv wheel that
carried the layer was shadowed, so the channel was silent with the flag on.) So
make this a standing gate on EVERY (re)deploy, before any measurement run:

> With the flag on and the door (re)started, a single authenticated
> `LOGIN -> SELECT INBOX` MUST produce exactly one `@measure cold_sync`
> (`direction: inbound`). If it does not, the measurement build is NOT live --
> stop and fix the deploy; do not start a measurement run.

```bash
# provoke one cold sync: LOGIN + SELECT INBOX only (no SEARCH, no body open).
# system/PAM mode reads the shared store, so any crew login proves the wiring.
python3 imap/smoke/emit_sanity.py --host <live-door-host>   # 10.1.1.2 (host) or the container addr

# assert it landed. Twisted's observer PREFIXES the line, so grep UNANCHORED:
journalctl -u postern-imap -o cat | grep '@measure cold_sync'   # expect one, direction=inbound
```

The integration test (`posternimap/tests/test_measure_integration.py`) guards the
config->emit WIRING against a code regression; this gate guards the DEPLOY -- the
test cannot see a stale install, only an on-door check can. Turn the flag back off
after the window (off is the production default and a true no-op).

## Tests

`posternimap/tests/test_measure.py`: the `Meter` on/off semantics (disabled is a
no-op; `timed` records `elapsed_ms` and span fields; it emits even when the block
raises; the default sink writes one well-formed `@measure` line), plus read-path
wiring (cold_sync/api_request fire on SELECT, window saturation is recorded, an
envelope scan emits zero `hydrate` then opening emits one, the token never leaks,
and a disabled meter emits nothing through the whole read path). Run with the rest:

```bash
python -m twisted.trial posternimap          # full suite
python -m twisted.trial posternimap.tests.test_measure
python -m mypy                                # the type gate (with Twisted==26.4.0)
```
