#!/bin/sh
# docker-entrypoint.sh -- load *_FILE secrets into env, then exec the proxy.
#
# Swarm mounts secrets at a path (e.g. /run/secrets/postern_imap_api_token). The
# proxy's config (config.py) reads POSTERN_API_TOKEN as a VALUE from the env, so we
# expand any <VAR>_FILE into <VAR> here. This keeps the secret VALUE out of the
# committed stack and out of the image: only the PATH is configured, the bytes are
# read at start. Mirrors the Go relay's *_FILE convention (EMAIL_RELAY_TOKEN_FILE)
# and the docker-library file_env idiom. The TLS cert/key are NOT loaded here: the
# proxy reads POSTERN_IMAP_TLS_CERT / POSTERN_IMAP_TLS_KEY as file PATHS directly,
# so those env vars point straight at the secret mount.
#
# Secret hygiene: the value is read into a local var and exported, NEVER echoed.
set -eu

load_secret() {
    # $1 = env var name. If <name>_FILE is set, read that file into <name>.
    name="$1"
    eval "path=\${${name}_FILE:-}"
    if [ -n "${path}" ]; then
        if [ ! -r "${path}" ]; then
            echo "docker-entrypoint: ${name}_FILE=${path} is not readable" >&2
            exit 1
        fi
        # Presence-only log; never the value.
        val="$(cat "${path}")"
        export "${name}=${val}"
        unset val
        unset "${name}_FILE"
        echo "docker-entrypoint: loaded ${name} from ${name}_FILE (SET)." >&2
    fi
}

# The per-function service token the proxy reads the store with (native/ldap/system
# modes). POSTERN_TRANSPORT_TOKEN is the native-mode transport bearer; load it too so
# either service-token mode can be driven entirely from swarm secrets.
load_secret POSTERN_API_TOKEN
load_secret POSTERN_API_TOKEN_DELETE
load_secret POSTERN_TRANSPORT_TOKEN

exec "$@"
