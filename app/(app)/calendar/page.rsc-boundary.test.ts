/**
 * Regression test for the production /calendar incident: app/(app)/calendar/page.tsx
 * (a Server Component - no "use client" directive) passed inline arrow
 * functions (dayHrefForView, dayHref) directly into CalendarToolbar and
 * MonthView, both "use client" Client Components. React Server Components
 * cannot serialize a function across that boundary, so every real request
 * to /calendar threw at render time - a failure class none of this
 * project's 475 other tests catch, since they call the underlying data/
 * pure-logic functions directly rather than rendering the actual JSX tree
 * through Next.js's RSC pipeline, and since /calendar is a fully dynamic
 * route (never prerendered by `next build`, only executed on a real
 * request).
 *
 * This repository has no existing tooling for a true RSC-rendering test
 * (no React Testing Library, no next/experimental/testmode harness, no
 * server-components test renderer) - building one from scratch was judged
 * out of scope for a surgical bug fix (see this pass's own "do not
 * redesign the entire testing architecture" instruction). Instead, this
 * uses the TypeScript compiler API (already a real project dependency,
 * "typescript" in package.json - not a new one) to parse the REAL AST of
 * calendar/page.tsx and calendar/page.tsx to structurally verify no
 * function-valued expression is ever passed as a JSX prop into any
 * imported Client Component - a genuine syntax-tree check, not a fragile
 * text/regex scan, and general enough to also catch any NEW function-prop
 * mistake in this file, not just a re-introduction of the exact two lines
 * that broke.
 *
 * Run with:
 *   node --import ./lib/automation/test-loader.mjs --test "app/(app)/calendar/page.rsc-boundary.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";

const REPO_ROOT = process.cwd();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const ts: typeof import("typescript") = require("typescript");

const PAGE_PATH = path.join(REPO_ROOT, "app/(app)/calendar/page.tsx");

/** True only when the file's own first statement is the literal directive "use client" - parsed via the real TS AST, not a text-prefix guess. */
function isClientComponentFile(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  const source = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const first = sourceFile.statements[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client");
}

/** Resolves a relative import specifier (e.g. "./_components/month-view") to its real file on disk. Non-relative imports (e.g. "@/lib/...") are intentionally not resolved - page.tsx's own Client Component imports are all relative, and fully replicating tsconfig path-alias resolution is out of scope for this focused check. */
function resolveRelativeImport(fromFile: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), importPath);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

type BoundaryCheckResult = { offenders: string[]; clientComponentNames: Set<string> };

function checkFileForFunctionPropsIntoClientComponents(filePath: string): BoundaryCheckResult {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Every locally-imported name that resolves to a real "use client" file.
  const clientComponentNames = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const resolved = resolveRelativeImport(filePath, stmt.moduleSpecifier.text);
    if (!resolved || !isClientComponentFile(resolved)) continue;
    const namedBindings = stmt.importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) clientComponentNames.add(element.name.text);
    }
  }

  const offenders: string[] = [];

  function visit(node: TS.Node) {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (clientComponentNames.has(tagName)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
          const expr = attr.initializer.expression;
          if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
            const line = sourceFile.getLineAndCharacterOfPosition(attr.getStart()).line + 1;
            offenders.push(`line ${line}: <${tagName} ${attr.name.getText(sourceFile)}={...}> is a function-valued prop passed into a Client Component`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { offenders, clientComponentNames };
}

test("calendar/page.tsx (a Server Component) never passes a function-valued prop into any imported Client Component", () => {
  const result = checkFileForFunctionPropsIntoClientComponents(PAGE_PATH);

  // A sanity check on the detector itself, not the page: if this file
  // stopped importing any real Client Component at all, the assertion
  // below would trivially pass for the wrong reason (nothing left to
  // check) - fail loudly so a future refactor of calendar/page.tsx can't
  // silently disable this regression test.
  assert.ok(
    result.clientComponentNames.size > 0,
    "expected calendar/page.tsx to import at least one real Client Component (CalendarToolbar/CalendarGrid/MonthView) - if this fails, the detector itself found nothing to check, which would make the real assertion below meaningless",
  );
  assert.deepEqual(
    result.offenders,
    [],
    `found function-valued props passed from the Server Component calendar/page.tsx into a Client Component - this is exactly the class of bug that broke production /calendar (React Server Components cannot serialize a function across that boundary):\n${result.offenders.join("\n")}`,
  );
});
