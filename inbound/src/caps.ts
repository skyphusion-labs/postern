// The native webmail session capability set (design-conformance note D2, contract 4), in
// its own module so the session code and the principal layer (#854) can both import it
// without importing each other. session.ts re-exports it; see the full note there.
export const NATIVE_SESSION_CAPS = ["read", "send", "delete", "organize"];
