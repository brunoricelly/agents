import { existsSync } from "node:fs";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "runtime-dependency-check-jwt-secret";
process.env.ENCRYPTION_KEY = "runtime-dependency-check-encryption-key";

for (const dependency of ["@esbuild", "esbuild", "langchain", "typescript"]) {
  if (existsSync(`node_modules/${dependency}`)) {
    throw new Error(`build-only dependency present at runtime: ${dependency}`);
  }
}

const { default: app } = await import("@/app");
const response = await app.handle(
  new Request(
    "http://runtime-dependency-check.invalid/.well-known/oauth-authorization-server",
  ),
);

if (response.status !== 200) {
  throw new Error(`runtime app probe returned HTTP ${response.status}`);
}

console.log("runtime dependency check passed");
