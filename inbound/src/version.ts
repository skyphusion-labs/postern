// Single source for the value the mailbox reports as its own build/release
// version (currently only GET /health). A test asserts this matches
// inbound/package.json so the wire cannot drift from the published tag the way
// the MCP serverInfo version drifted while stuck at a stale literal (mcp/#573).
//
// Why a guarded literal and not `import pkg from "../package.json"`: this
// package has no explicit rootDir, but tsconfig.json scopes `include` to
// `src/**/*.ts`, so importing a file above src breaks the build the same way
// it does for mcp/tsconfig (rootDir: "src"). The literal is a copy, but it is
// a copy the test makes impossible to ship wrong -- see inbound/version.test.ts.
export const VERSION = "1.4.5";
