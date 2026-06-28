#!/bin/sh
# docker-entrypoint.sh -- load *_FILE secrets into env, then exec the relay.
#
# Swarm mounts secrets at a path (e.g. /run/secrets/postern_send_token). The relay
# reads each token/password as a VALUE from the env (config.go), so we expand any
# <VAR>_FILE into <VAR> here. This keeps the secret VALUE out of the committed
# stack and out of the image: only the PATH is configured, the bytes are read at
# start. Mirrors the IMAP door's entrypoint and the docker-library file_env idiom.
#
# The TLS cert/key are NOT loaded here: the relay reads SUBMISSION_TLS_CERT /
# SUBMISSION_TLS_KEY as file PATHS directly, so those env vars point straight at
# the secret mount.
#
# Secret hygiene: each value is read into a local var and exported, NEVER echoed.
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

# Submission send bridge to the worker /api/send (the mailbox API token).
load_secret POSTERN_SEND_TOKEN
# Transport bearer: native-mode /api/smtp-auth check, inbound /ingest, and the
# outbound /dispatch bridge all authenticate with it.
load_secret POSTERN_TRANSPORT_TOKEN
# Legacy inbound send bearer (EMAIL_WORKER_URL path).
load_secret EMAIL_RELAY_TOKEN
# Bring-your-own upstream SMTP password (outbound /dispatch).
load_secret SMTP_OUT_PASSWORD
# LDAP search+bind service-account password (AUTH_BACKEND=ldap).
load_secret LDAP_BIND_PASSWORD

exec "$@"
