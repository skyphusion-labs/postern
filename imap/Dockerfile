# postern-imap -- the 993 IMAP read door as a versioned container image.
#
# WHY THIS SHAPE (the deploy-gap fix): the host install ran `python -m posternimap`
# with WorkingDirectory=/opt/postern-imap, so a stale source tree on the box could
# SHADOW the installed package and serve old code (the silent 4-commit deploy gap).
# Here we `pip install` the package into a venv and run the `postern-imap`
# console_script from site-packages. There is NO loose source tree in the runtime
# image and NO `python -m` with a WorkingDirectory, which structurally kills that
# whole shadow/deploy-gap class: the image content IS the deployed code, pinned by
# the GHCR short-SHA tag.
#
# Build context is imap/ (see .github/workflows/imap-image.yml).

# ---- stage 1: builder -- resolve + install the package into a self-contained venv
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

WORKDIR /src
COPY . .

# .[tls,ldap] is the WHOLE point: tls = pyOpenSSL + service-identity (native 993
# IMAPS, audit #106 TLS 1.2+ floor); ldap = ldap3 (pure-Python, no libldap/C build,
# so no compiler is needed in this image). Both resolve from manylinux wheels.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install '.[tls,ldap]'

# ---- stage 2: runtime -- slim, non-root, venv only (no build tools, no source tree)
FROM python:3.12-slim AS runtime

# libcap2-bin only to setcap the interpreter so the NON-ROOT user may bind the
# privileged port 993 (CAP_NET_BIND_SERVICE), scoped to this one interpreter. This
# is the documented mechanism, not a hack: we run unprivileged AND bind 993 without
# ever running as root. NET_BIND_SERVICE is in Docker's default capability set, so
# the file capability is effective at runtime; the stack also requests it explicitly.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libcap2-bin; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 10001 postern; \
    useradd --system --uid 10001 --gid postern --no-create-home --home /nonexistent --shell /usr/sbin/nologin postern; \
    setcap 'cap_net_bind_service=+ep' "$(readlink -f /usr/local/bin/python3)"

# Bring the resolved venv across; the builder's source tree is left behind.
COPY --from=builder /opt/venv /opt/venv

# Entrypoint shim: loads *_FILE secrets (POSTERN_API_TOKEN) from their mount path
# into the unsuffixed env var, so no secret value ever lands in the image or the
# committed stack. Mirrors the relay's *_FILE convention + the docker-library idiom.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    POSTERN_IMAP_HOST=0.0.0.0 \
    POSTERN_IMAP_PORT=993

USER postern
EXPOSE 993

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postern-imap"]
