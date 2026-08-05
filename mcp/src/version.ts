// Single source for the MCP server's advertised version string. A test asserts
// this matches mcp/package.json so MCP serverInfo cannot drift from the published
// package the way the hardcoded "1.3.0" did while package.json sat at 1.4.0.
//
// Why a guarded literal and not `import pkg from "../package.json"`: mcp/tsconfig
// sets rootDir: "src", so importing a file above it breaks the build. The literal
// is a copy, but it is a copy the test makes impossible to ship wrong -- see
// mcp/test/version.test.ts.
export const VERSION = "1.4.0";
