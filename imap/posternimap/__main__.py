"""Run the postern-imap proxy: `python -m posternimap`.

Config comes entirely from the environment (see config.Config); there are no
flags. On a config error we print the reason (never a secret) and exit non-zero.
"""

from __future__ import annotations

import sys

from .config import Config, ConfigError
from .server import run


def main() -> int:
    try:
        cfg = Config.from_env()
    except ConfigError as e:
        print(f"postern-imap: configuration error: {e}", file=sys.stderr)
        return 2
    run(cfg)  # blocks in the reactor until shutdown
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
