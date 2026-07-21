"""postern-client: a dependency-light Python client + CLI for the Postern mailbox API.

See client.py for the importable PosternClient and cli.py for the `postern`
command. The API origin and token come from the environment
(POSTERN_API_URL / POSTERN_API_TOKEN); nothing is hardcoded and the token is
never logged.
"""

from __future__ import annotations

from .client import (
    Attachment,
    PosternAuthError,
    PosternClient,
    PosternError,
    from_env,
)

__all__ = [
    "PosternClient",
    "PosternError",
    "PosternAuthError",
    "Attachment",
    "from_env",
]

__version__ = "1.0.4"
