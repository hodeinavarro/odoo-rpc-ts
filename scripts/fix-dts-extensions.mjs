// tsc's rewriteRelativeImportExtensions rewrites .ts -> .js in JS emit but NOT
// in declaration files (TS 5.7+ documented limitation), leaving d.ts specifiers
// that consumers cannot resolve. Rewrite them here, post-build.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELATIVE_TS = /(?<=(?:from|import\()\s*["'])(\.\.?\/[^"']+)\.ts(?=["'])/g;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

let rewritten = 0;
for (const file of walk("dist")) {
  if (!file.endsWith(".d.ts")) continue;
  const source = readFileSync(file, "utf8");
  const fixed = source.replace(RELATIVE_TS, "$1.js");
  if (fixed !== source) {
    writeFileSync(file, fixed);
    rewritten += 1;
  }
}
console.log(`fix-dts-extensions: rewrote ${rewritten} declaration file(s)`);
