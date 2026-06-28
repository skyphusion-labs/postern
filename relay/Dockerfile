# postern-relay -- the Go mail relay (587 submission door + loopback intake) as a
# versioned container image.
#
# WHY THIS SHAPE: the relay is moving off the host systemd install onto a versioned
# container image (CI -> GHCR -> Swarm), the same move the 993 IMAP door made. The
# image content IS the deployed code, pinned by the GHCR short-SHA tag, so there is
# no host binary to drift and no stale unit to shadow it.
#
# AUTH BACKEND: this image is built CGO-FREE (CGO_ENABLED=0), so it ships the
# native + ldap auth backends but NOT the system/PAM backend (auth_system_pam.go is
# behind the `pam` build tag and needs cgo + host nslcd/PAM, which does not belong
# in a clean container). The fleet container deploy selects AUTH_BACKEND=ldap and
# binds LDAPS to dischord -- symmetric with the IMAP door's pure-Python ldap choice.
# A PAM deploy stays a host build; it is intentionally not a container target.
#
# Build context is relay/ (see .github/workflows/relay-image.yml).

# ---- stage 1: builder -- compile a static, cgo-free binary ------------------
FROM golang:1.25-bookworm AS builder

ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath

WORKDIR /src

# Resolve modules first so the layer caches on go.mod/go.sum alone.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# A static binary: no cgo, no `pam` tag. The result runs on a near-empty runtime.
RUN go build -ldflags='-s -w' -o /out/postern-relay .

# ---- stage 2: runtime -- slim, non-root, binary + CA roots only -------------
FROM debian:bookworm-slim AS runtime

# ca-certificates: the relay makes outbound TLS calls (worker /api/send + /ingest
# over HTTPS, and LDAPS to the directory), so it needs the system trust store.
# libcap2-bin: only to setcap the binary so the NON-ROOT user may bind the
# privileged submission port (587) via CAP_NET_BIND_SERVICE, scoped to this one
# binary. This is the documented mechanism, not a hack: we run unprivileged AND
# bind 587 without ever running as root. NET_BIND_SERVICE is in Docker's default
# capability set, so the file capability is effective at runtime; the stack also
# requests it explicitly.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates libcap2-bin; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 10001 postern; \
    useradd --system --uid 10001 --gid postern --no-create-home --home /nonexistent --shell /usr/sbin/nologin postern

COPY --from=builder /out/postern-relay /usr/local/bin/postern-relay
RUN setcap 'cap_net_bind_service=+ep' /usr/local/bin/postern-relay

# Entrypoint shim: loads *_FILE secrets (the send/transport/legacy tokens and the
# SMTP/LDAP passwords) from their mount paths into the unsuffixed env var, so no
# secret value ever lands in the image or the committed stack. Mirrors the IMAP
# door's entrypoint + the docker-library file_env idiom. The TLS cert/key are NOT
# loaded here: the relay reads SUBMISSION_TLS_CERT / SUBMISSION_TLS_KEY as file
# PATHS directly, so those env vars point straight at the secret mount.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV SUBMISSION_HOSTNAME=localhost

USER postern

# 587 = STARTTLS submission. The loopback intake door (SMTP_LISTEN) is loopback
# only by the relay's F4 invariant, so it is not EXPOSEd. 465 (implicit TLS) is a
# valid SUBMISSION_LISTENERS option too; expose it at the stack if used.
EXPOSE 587

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postern-relay"]
