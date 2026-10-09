// Checks the boundaries docs/architecture.md and docs/protocol.md state in
// prose, so a change cannot quietly cross them: Herdr's API is spoken only in
// the bridge's Herdr adapter, the trackers reach a floor only through the
// Machine they are given, the protocol imports nothing (the bridge and the
// page both load it), the appearance registry is data with no DOM, Pixi or
// bridge in it, and the page and the bridge meet only in the protocol.
//
// It reads every JavaScript and TypeScript file under the repository (or the
// folder given as the first argument), finds what each one imports (`import`,
// `export ... from`, `import("...")`, `require("...")`) and its string
// literals, with comments left out, and checks them against RULES. Paths are
// relative to the repository root, so when files move only RULES changes, and
// a rule whose files no longer exist fails instead of passing on nothing.
//
// Plain Node, no dependencies. Run it with `pnpm check:boundaries`; it prints
// one line per violation and exits 1 if there is any.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Herdr adapter: the only code that speaks Herdr's API.
const HERDR_ADAPTER = ["packages/bridge/src/machine.js", "packages/bridge/src/herdr.js", "packages/bridge/src/remote.js"];
// Tests drive a stand-in Herdr and check that nothing of it leaks, so they name it.
const TESTS = ["**/*.test.mjs", "packages/bridge/src/fixtures/**"];
// Workspace packages are imported by relative path or by name, and a name is checked as written.
const BRIDGE = ["packages/bridge/**", "@kauak/bridge", "@kauak/bridge/**"];
// The CLI, bin/kauak.js, and the bundle of the bridge the npm package carries.
const KAUAK = ["packages/kauak/**", "kauak", "kauak/**"];
const WEB = ["packages/web/**", "@kauak/web", "@kauak/web/**"];

// Each rule applies to `files` (minus `except`) and checks any of:
//   forbid   imports that may not be made (repository paths or package names)
//   only     the only imports allowed; anything else is a violation
//   strings  string literals that may not appear
//   globals  globals (the browser's, Node's) that may not be used
const RULES = [
  {
    rule: "only the Herdr adapter (machine.js, herdr.js, remote.js) imports herdr.js",
    files: ["**"],
    except: [...HERDR_ADAPTER, ...TESTS],
    forbid: ["packages/bridge/src/herdr.js", "packages/kauak/bridge/herdr.js", "@kauak/bridge/herdr.js"],
  },
  {
    rule: "the trackers reach a floor through the Machine they are given, not the Herdr adapter",
    files: ["packages/bridge/src/context.js", "packages/bridge/src/diffs.js", "packages/bridge/src/commands.js"],
    forbid: ["packages/bridge/src/machine.js", "packages/bridge/src/herdr.js", "@kauak/bridge/machine.js", "@kauak/bridge/herdr.js"],
  },
  {
    rule: "Herdr's method and event names stay in the Herdr adapter",
    files: ["**"],
    // The demo's made-up terminals show code that calls Herdr.
    except: [...HERDR_ADAPTER, ...TESTS, "packages/web/src/demo.ts"],
    strings: /^(session|events|workspace|worktree|tab|pane|agent|layout)\.[a-z][a-z_]*$/,
  },
  {
    rule: "the protocol imports nothing, as the bridge and the page both load it: no workspace package, Node or DOM",
    files: ["packages/protocol/**"],
    except: TESTS,
    only: [],
    globals: /^(window|document|navigator|location|localStorage|sessionStorage|(HTML|SVG)\w*Element|process|Buffer)$/,
  },
  {
    rule: "other packages import the protocol by its name, @kauak/protocol, as their package.json declares, not by its path",
    files: ["**"],
    except: ["packages/protocol/**"],
    forbid: ["packages/protocol/**"],
  },
  {
    rule: "the appearance registry imports nothing but its contracts: no DOM, Pixi, xterm, bridge or page",
    files: ["packages/appearance/src/registry.ts"],
    only: ["packages/appearance/src/contracts.ts"],
    globals: /^(window|document|navigator|location|localStorage|sessionStorage|(HTML|SVG)\w*Element)$/,
  },
  {
    rule: "appearance contracts and validation import nothing from the bridge, the CLI or the page",
    files: ["packages/appearance/**"],
    forbid: [...BRIDGE, ...KAUAK, ...WEB],
  },
  {
    rule: "the page imports the protocol and the appearance packages, and nothing of the bridge or the CLI",
    files: ["packages/web/**"],
    forbid: [...BRIDGE, ...KAUAK],
  },
  {
    rule: "the bridge and the CLI import nothing from the page",
    files: ["packages/bridge/**", "packages/kauak/**"],
    forbid: WEB,
  },
  {
    rule: "the bridge imports nothing from the CLI, which starts it",
    files: ["packages/bridge/**"],
    forbid: KAUAK,
  },
];

const SOURCE = /\.(js|mjs|cjs|ts|mts|cts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-demo"]);
// How a relative import without its file's extension is found, as TypeScript and Vite do.
const RESOLVE = ["", ".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json", "/index.ts", "/index.js"];
// After these words a `/` starts a regular expression, not a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set("return typeof instanceof in of new delete void throw case do else yield await".split(" "));

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
const files = walk(root).sort();
const problems = [];

const scanned = new Map();
for (const file of files) {
  const result = scan(fs.readFileSync(path.join(root, file), "utf8"));
  // A file the tokenizer lost its way in would pass unchecked, so say so instead.
  if (!result.balanced) problems.push(`${file}: could not be read reliably (unbalanced braces or template literal), fix scan()`);
  scanned.set(file, result);
}

for (const r of RULES) {
  const matched = files.filter((f) => matches(f, r.files) && !matches(f, r.except));
  if (!matched.length) problems.push(`scripts/check-boundaries.mjs: rule matches no files, update RULES: ${r.rule}`);
  for (const file of matched) {
    const { imports, strings, identifiers } = scanned.get(file);
    for (const { specifier, line } of imports) {
      const target = resolve(file, specifier);
      const bad = r.only ? !matches(target, r.only) : matches(target, r.forbid);
      if (bad) problems.push(`${file}:${line}: imports "${specifier}"${target === specifier ? "" : ` (${target})`}: ${r.rule}`);
    }
    if (r.strings)
      for (const { value, line } of strings) if (r.strings.test(value)) problems.push(`${file}:${line}: names "${value}": ${r.rule}`);
    if (r.globals)
      for (const { name, line } of identifiers) if (r.globals.test(name)) problems.push(`${file}:${line}: uses ${name}: ${r.rule}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`check-boundaries: ${problems.length} violation${problems.length === 1 ? "" : "s"} in ${files.length} files`);
  process.exit(1);
}
console.log(`check-boundaries: ${files.length} files, ${RULES.length} rules, no violations`);

/** Source files under root, as forward-slash paths relative to it. Dot folders (.git, .claude) are skipped. */
function walk(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), name));
    else if (entry.isFile() && SOURCE.test(entry.name)) out.push(name);
  }
  return out;
}

/** A relative import as the repository path it loads; a package import as it is written. */
function resolve(from, specifier) {
  const bare = specifier.replace(/[?#].*$/, "");
  if (!bare.startsWith(".")) return specifier;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), bare));
  const candidates = RESOLVE.map((ext) => base + ext);
  // TypeScript lets `./x.js` mean x.ts.
  if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.m?js$/, ".ts"));
  return candidates.find((c) => fs.statSync(path.join(root, c), { throwIfNoEntry: false })?.isFile()) ?? base;
}

function matches(file, globs = []) {
  return globs.some((g) => globToRegExp(g).test(file));
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` is any number of folders, a trailing `**` anything at all.
      const folders = glob[i + 2] === "/";
      re += folders ? "(?:.*/)?" : ".*";
      i += folders ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------- scanning

/**
 * Tokenizes JavaScript or TypeScript just enough to tell code from comments,
 * strings, template literals and regular expressions, then reads the imports
 * from the tokens. Not a parser: it needs the file to be valid, which the
 * type check and the tests make sure of.
 */
function scan(src) {
  const { tokens, balanced } = tokenize(src);
  const imports = [];
  const strings = [];
  const identifiers = [];
  const at = (i) => tokens[i] ?? { type: "eof", value: "" };
  const isPunct = (t, v) => t.type === "punct" && t.value === v;
  const isWord = (t, v) => t.type === "word" && t.value === v;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "string") strings.push({ value: t.value, line: t.line });
    if (t.type !== "word") continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    const member = isPunct(prev, ".") || isPunct(prev, "?.");
    const objectKey = (isPunct(prev, "{") || isPunct(prev, ",")) && isPunct(next, ":");
    if (!member && !objectKey) identifiers.push({ name: t.value, line: t.line });
    if (member) continue;

    if (t.value === "import" && isPunct(next, "(")) {
      // import("x"), and TypeScript's typeof import("x")
      if (at(i + 2).type === "string") imports.push(specifierOf(at(i + 2)));
    } else if (t.value === "require" && isPunct(next, "(") && at(i + 2).type === "string" && isPunct(at(i + 3), ")")) {
      imports.push(specifierOf(at(i + 2)));
    } else if (t.value === "import" && next.type === "string") {
      imports.push(specifierOf(next));
    } else if (t.value === "import" && !isPunct(next, ".")) {
      // import a, { b, type c } from "x" / import * as a from "x" / import type { a } from "x"
      for (let j = i + 1; j < tokens.length && !isPunct(tokens[j], ";"); j++) {
        if (isWord(tokens[j], "from") && at(j + 1).type === "string") {
          imports.push(specifierOf(at(j + 1)));
          i = j + 1;
          break;
        }
        if (isWord(tokens[j], "import") || isWord(tokens[j], "export")) break;
      }
    } else if (t.value === "export") {
      // export * from "x" / export * as a from "x" / export { a } from "x" / export type * from "x"
      let j = i + 1;
      if (isWord(at(j), "type")) j++;
      if (isPunct(at(j), "*")) {
        j++;
        if (isWord(at(j), "as")) j += 2;
      } else if (isPunct(at(j), "{")) {
        while (j < tokens.length && !isPunct(tokens[j], "}")) j++;
        j++;
      } else continue;
      if (isWord(at(j), "from") && at(j + 1).type === "string") imports.push(specifierOf(at(j + 1)));
    }
  }
  return { imports, strings, identifiers, balanced };
}

function specifierOf(token) {
  return { specifier: token.value, line: token.line };
}

/** Tokens: words, strings (quoted, or template literals without ${}), numbers and punctuation; comments are dropped. */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  // Open template literals' brace depths, to know which `}` resumes a template.
  const templates = [];
  let braces = 0;

  const push = (type, value, startLine = line) => tokens.push({ type, value, line: startLine });
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "word") return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
    if (prev.type === "punct") return ![")", "]", "}"].includes(prev.value);
    // Just after a template literal's `${`, an expression starts.
    return prev.type === "template" && !prev.closed;
  };

  // Reads a template literal's text from i (just past ` or }) to its end or its next ${.
  const templateChunk = (startLine) => {
    let text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "\n") line++;
      if (c === "`") {
        i++;
        return { text, done: true };
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return { text, done: false, startLine };
      }
      text += c;
      i++;
    }
    return { text, done: true };
  };

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] === "\n") line++;
    } else if (c === '"' || c === "'") {
      const startLine = line;
      let value = "";
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          if (src[i + 1] === "\n") line++;
          value += src.slice(i, i + 2);
          i += 2;
        } else value += src[i++];
      }
      if (src[i] === c) i++;
      push("string", value, startLine);
    } else if (c === "`") {
      const startLine = line;
      i++;
      const chunk = templateChunk(startLine);
      if (chunk.done) push("string", chunk.text, startLine);
      else {
        push("template", chunk.text, startLine);
        templates.push(braces);
      }
    } else if (c === "}" && templates.length && templates[templates.length - 1] === braces) {
      templates.pop();
      i++;
      const chunk = templateChunk(line);
      push("template", chunk.text);
      if (chunk.done) tokens[tokens.length - 1].closed = true;
      else templates.push(braces);
    } else if (c === "/" && regexAllowed()) {
      let inClass = false;
      i++;
      while (i < src.length && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      push("regex", "");
    } else if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      const start = i;
      while (i < src.length && /[\w$\u0080-\uffff]/.test(src[i])) i++;
      push("word", src.slice(start, i));
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(d))) {
      const start = i;
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      push("number", src.slice(start, i));
    } else if (c === "?" && d === "." && !/[0-9]/.test(src[i + 2])) {
      push("punct", "?.");
      i += 2;
    } else {
      if (c === "{") braces++;
      if (c === "}") braces--;
      push("punct", c);
      i++;
    }
  }
  return { tokens, balanced: braces === 0 && !templates.length };
}
