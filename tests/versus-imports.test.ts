/**
 * The sound duel's import rules (SOUND-DUEL.md "Modules", "Worklet", "Rig"):
 *
 *  - nothing outside src/versus and src/link imports them, except types:
 *    main.ts reaches them through exactly one `import("./versus/lobby")`, so
 *    the duel is a lazily loaded chunk (and main.ts keeps its two
 *    `import("./game/replay")`: Save battle doesn't load the viewer);
 *  - src/game imports neither, except types;
 *  - src/versus and src/link use only `import type` from src/arena;
 *  - the rig never imports game code;
 *  - the worklet's import graph uses only the AudioWorklet's globals, with
 *    their declarations module-local in worklet.ts.
 *
 * The sources are read with the TypeScript parser, so comments and strings
 * never count and `import { type A }` is told from `import { A }`. (The same
 * worklet rule is also in tests/link-worklet.test.ts, by regular expression.)
 *
 * Where the spec is silent:
 *  - type-only is `import type …`, `export type … from`, or a list whose
 *    names are all marked `type` (erased: the project has no
 *    verbatimModuleSyntax). A bare `import "…"` and a stylesheet count as
 *    value imports;
 *  - "outside" is everything under src/ but src/versus and src/link, and a
 *    computed `import(x)` there fails (it can't be checked);
 *  - the worklet's globals are checked as references: `a.window` or
 *    `{ fetch: … }` name a property, not the global.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Every module under src/, as text, keyed "../src/…". */
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** One import of a module: what it names, how, and whether it is erased (types only). */
interface Ref {
  spec: string;
  /** Resolved: a source file ("../src/…"), another file it names (a stylesheet), or null (a package). */
  path: string | null;
  kind: "static" | "dynamic" | "reexport";
  typeOnly: boolean;
  line: number;
}

/** `spec` from `from` as a key of `sources`, or the path of another file it names (a stylesheet); null: a package. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("?")[0]!.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const base = parts.join("/");
  for (const p of [base, `${base}.ts`, `${base}/index.ts`]) if (p in sources) return p;
  return /\.[a-z]+$/.test(base) ? base : null;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(path: string): ts.SourceFile {
  let sf = parsed.get(path);
  if (!sf) {
    sf = ts.createSourceFile(path, sources[path]!, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    parsed.set(path, sf);
  }
  return sf;
}

/** Every import, re-export and dynamic import() in a file (`typeof import("…")` is a type: left out). */
function refsOf(path: string): Ref[] {
  const sf = parse(path);
  const out: Ref[] = [];
  const add = (spec: ts.Expression | undefined, kind: Ref["kind"], typeOnly: boolean, node: ts.Node) => {
    if (!spec || !ts.isStringLiteralLike(spec)) {
      // (a computed import() can't be checked: only allowed where nothing is at stake)
      if (kind === "dynamic") out.push({ spec: "<computed>", path: null, kind, typeOnly: false, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      return;
    }
    out.push({ spec: spec.text, path: resolve(path, spec.text), kind, typeOnly, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      // `import type …`, or `import { type A, type B }` (erased: no verbatimModuleSyntax); a bare `import "…"` runs the module
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      add(node.moduleSpecifier, "static", typeOnly, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      const typeOnly = node.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly));
      add(node.moduleSpecifier, "reexport", typeOnly, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, "static", node.isTypeOnly, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0], "dynamic", false, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const all = Object.keys(sources).sort();
const inDuel = (p: string) => p.startsWith("../src/versus/") || p.startsWith("../src/link/");
const where = (from: string, r: Ref) => `${from.slice(3)}:${r.line} ${r.kind === "dynamic" ? `import("${r.spec}")` : `imports "${r.spec}"`}`;

describe("the sound duel's import rules", () => {
  it("finds the modules it checks", () => {
    for (const p of ["../src/main.ts", "../src/versus/lobby.ts", "../src/versus/lobby-machine.ts", "../src/versus/feed.ts", "../src/link/worklet.ts", "../src/link/rig.ts", "../src/game/GameScene.ts", "../src/arena/record.ts"])
      expect(all, p).toContain(p);
    // (the parser sees through comments: the lobby's header names the import it is reached by)
    expect(refsOf("../src/versus/lobby.ts").some((r) => r.spec === "./versus/lobby")).toBe(false);
  });

  it("nothing outside src/versus and src/link imports them, except types; main.ts's one import(\"./versus/lobby\") aside", () => {
    const bad: string[] = [];
    const entries: string[] = [];
    for (const from of all) {
      if (inDuel(from)) continue;
      for (const r of refsOf(from)) {
        if (r.kind === "dynamic" && r.path === null && r.spec === "<computed>") bad.push(`${where(from, r)}: a computed import()`);
        if (!r.path || !inDuel(r.path) || r.typeOnly) continue;
        if (from === "../src/main.ts" && r.kind === "dynamic" && r.path === "../src/versus/lobby.ts") entries.push(where(from, r));
        else bad.push(where(from, r));
      }
    }
    expect(bad).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("main.ts has exactly one import(\"./versus/lobby\") and exactly two import(\"./game/replay\")", () => {
    const refs = refsOf("../src/main.ts").filter((r) => r.kind === "dynamic");
    expect(refs.filter((r) => r.path === "../src/versus/lobby.ts")).toHaveLength(1);
    expect(refs.filter((r) => r.path === "../src/game/replay.ts")).toHaveLength(2);
    // (and the text says so, as tests/arena.test.ts reads it)
    const main = sources["../src/main.ts"]!;
    expect(main.match(/import\(["']\.\/versus\/lobby["']\)/g)?.length).toBe(1);
    expect(main.match(/import\("\.\/game\/replay"\)/g)?.length).toBe(2);
  });

  it("src/game imports neither src/link nor src/versus, except types", () => {
    const bad: string[] = [];
    for (const from of all.filter((p) => p.startsWith("../src/game/")))
      for (const r of refsOf(from)) if (r.path && inDuel(r.path) && !r.typeOnly) bad.push(where(from, r));
    expect(bad).toEqual([]);
  });

  it("src/versus and src/link use only import type from src/arena", () => {
    const bad: string[] = [];
    for (const from of all.filter(inDuel))
      for (const r of refsOf(from)) if (r.path?.startsWith("../src/arena/") && !r.typeOnly) bad.push(where(from, r));
    expect(bad).toEqual([]);
  });

  it("the lobby machine imports no sheet, feed or UI code", () => {
    const graph = valueGraph("../src/versus/lobby-machine.ts");
    expect(graph.problems).toEqual([]);
    expect([...graph.files].filter((f) => f.startsWith("../src/ui/"))).toEqual([]);
    for (const f of ["../src/versus/lobby.ts", "../src/versus/feed.ts", "../src/game/audio.ts", "../src/game/GameScene.ts"])
      expect(graph.files.has(f), f).toBe(false);
  });

  it("the rig never imports game code: its value imports stay in src/link and src/sim", () => {
    const graph = valueGraph("../src/link/rig.ts");
    expect(graph.problems).toEqual([]);
    expect([...graph.files].filter((f) => !/^\.\.\/src\/(link|sim)\//.test(f))).toEqual([]);
  });
});

/** The files a module's value imports reach (type imports are erased), and the imports that aren't source files. */
function valueGraph(entry: string): { files: Set<string>; problems: string[] } {
  const files = new Set<string>();
  const problems: string[] = [];
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const r of refsOf(file)) {
      if (r.typeOnly) continue;
      if (r.kind === "dynamic") problems.push(`${where(file, r)}: a dynamic import`);
      else if (!r.path || !(r.path in sources)) problems.push(`${where(file, r)}: not a source file`);
      else todo.push(r.path);
    }
  }
  return { files, problems };
}

/** Names the AudioWorklet's global scope doesn't have (or that a modem must not use). */
const BANNED = new Set([
  "performance", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame", "self", "window", "document", "location",
  "navigator", "TextEncoder", "TextDecoder", "crypto", "fetch", "XMLHttpRequest", "localStorage", "indexedDB"
]);

/** A name as a property of something (`a.window`, `{ self: 1 }`, `class { fetch() {} }`), not a reference to a global. */
function isMemberName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isPropertySignature(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isMethodSignature(p) && p.name === id) ||
    (ts.isGetAccessor(p) && p.name === id) ||
    (ts.isSetAccessor(p) && p.name === id) ||
    (ts.isEnumMember(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    ts.isQualifiedName(p)
  );
}

/** What a worklet module uses that the AudioWorklet's scope doesn't allow. */
function workletProblems(path: string): string[] {
  const sf = parse(path);
  const out: string[] = [];
  const at = (n: ts.Node, what: string) => out.push(`${path.slice(3)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && BANNED.has(node.text) && !isMemberName(node)) at(node, node.text);
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) at(node, "import.meta");
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) at(node, "import()");
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Math" && node.name.text === "random") at(node, "Math.random");
    else if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) at(node, "declare global");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the worklet's import graph", () => {
  const graph = valueGraph("../src/link/worklet.ts");
  const files = [...graph.files].sort();

  it("stays in src/link and src/sim, without the main thread's transport", () => {
    expect(graph.problems).toEqual([]);
    expect(files).toContain("../src/link/modem/core.ts");
    expect(files).toContain("../src/link/worklet-protocol.ts");
    expect(files.filter((f) => !/^\.\.\/src\/(link|sim)\//.test(f))).toEqual([]);
    expect(files).not.toContain("../src/link/worklet-transport.ts");
    expect(files).not.toContain("../src/link/rig.ts");
  });

  it("uses only the AudioWorklet's globals, declared module-local in worklet.ts", () => {
    expect(files.flatMap(workletProblems)).toEqual([]);
    // the scope's own names: `declare const` / `declare function` at the top of worklet.ts, never `declare global`
    const sf = parse("../src/link/worklet.ts");
    const declared = new Set<string>();
    for (const s of sf.statements) {
      const ambient = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
      if (!ambient) continue;
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) declared.add(d.name.text);
      if (ts.isFunctionDeclaration(s) && s.name) declared.add(s.name.text);
    }
    for (const name of ["sampleRate", "currentFrame", "AudioWorkletProcessor", "registerProcessor"]) expect([...declared], name).toContain(name);
    // (and no other file of the graph declares them: they belong to the worklet alone)
    for (const f of files.filter((f) => f !== "../src/link/worklet.ts")) expect(sources[f], f).not.toMatch(/^declare (const|function) (sampleRate|currentFrame|AudioWorkletProcessor|registerProcessor)\b/m);
  });
});
