// The MCP Registry entry (server.json) must agree with package.json, or the registry refuses the
// publish ("Registry validation failed for package") or lists a version that does not exist on npm.
// A release bumps package.json, src/version.ts and both versions in server.json together.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as {
  name: string;
  description: string;
  version: string;
  packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string }; environmentVariables: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }> }>;
};
const mcpName = (pkg as unknown as { mcpName?: string }).mcpName;

describe("server.json (MCP Registry) matches package.json", () => {
  it("package.json carries mcpName, and it is the server.json name", () => {
    expect(mcpName).toBe("io.github.skyphusion-labs/postern-mcp");
    expect(server.name).toBe(mcpName);
  });
  it("versions match package.json", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].version).toBe(pkg.version);
  });
  it("the package is this npm package, over stdio", () => {
    expect(server.packages[0].registryType).toBe("npm");
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].transport.type).toBe("stdio");
  });
  it("the description fits the registry's 100-character limit", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
  it("declares the two required env vars, and every token as a secret", () => {
    const env = server.packages[0].environmentVariables;
    const byName = new Map(env.map((e) => [e.name, e]));
    expect(byName.get("POSTERN_API_URL")?.isRequired).toBe(true);
    expect(byName.get("POSTERN_API_TOKEN")?.isRequired).toBe(true);
    for (const e of env.filter((v) => v.name.endsWith("_TOKEN"))) expect(e.isSecret).toBe(true);
  });
});
