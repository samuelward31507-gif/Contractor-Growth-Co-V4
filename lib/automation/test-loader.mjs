// Node module-resolution loader for running this repo's node:test files
// directly with plain Node (no bundler). Next.js's own "bundler"
// moduleResolution (tsconfig.json) lets every source file write ordinary
// extensionless relative imports ("./catalog") and "@/" path-aliased
// imports ("@/lib/settings/queries") - correct and unchanged for the real
// app, which Next.js's bundler resolves. Plain `node --test` has no such
// bundler and needs a literal, resolvable specifier for every import, so
// test files that load a source module transitively pulling in either
// import style fail with ERR_MODULE_NOT_FOUND unless something bridges the
// two. This loader is that bridge - it does not change any production
// source file, tsconfig, or package.json.
//
// Usage:
//   node --import ./lib/automation/test-loader.mjs --test lib/automation/*.test.ts
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = process.cwd();

const loaderSource = `
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = ${JSON.stringify(ROOT)};

function withTsExtension(fullPathNoExt) {
  const candidate = fullPathNoExt + ".ts";
  return fs.existsSync(candidate) ? candidate : null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const full = path.join(ROOT, specifier.slice(2));
    const withExt = path.extname(full) ? full : withTsExtension(full) ?? full;
    return nextResolve(pathToFileURL(withExt).href, context);
  }

  if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const full = path.join(parentDir, specifier);
    const withExt = withTsExtension(full);
    if (withExt) {
      return nextResolve(pathToFileURL(withExt).href, context);
    }
  }

  return nextResolve(specifier, context);
}
`;

register("data:text/javascript," + encodeURIComponent(loaderSource), pathToFileURL(path.join(ROOT, "package.json")).href);
