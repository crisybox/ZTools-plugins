import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const imgModules = path.join(root, "dist", "preload", "node_modules", "@img");
const requiredPackages = [
  "sharp-darwin-arm64",
  "sharp-libvips-darwin-arm64",
  "sharp-darwin-x64",
  "sharp-libvips-darwin-x64"
];

const missing = [];
for (const packageName of requiredPackages) {
  try {
    await fs.access(path.join(imgModules, packageName));
  } catch {
    missing.push(packageName);
  }
}

if (missing.length > 0) {
  throw new Error(`Missing macOS sharp runtime packages: ${missing.join(", ")}`);
}

console.log(JSON.stringify({ ok: true, packages: requiredPackages }, null, 2));
