// Slash commands for the message box's "/" menu, per agent kind.
//
// Agents do not say which commands they have, so the list is rebuilt the way
// the agent itself would build it: its built-in commands, plus the command,
// skill and prompt files it would load for that folder. Files are only read on
// this machine; a remote floor gets the built-ins.

import { type Dirent, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@kauak/protocol";
import type { BridgeConfig } from "../../config.ts";

/** Where this machine's agents keep their user-wide commands, from the bridge's config. */
type AgentDirs = Pick<BridgeConfig, "claudeDir" | "codexDir">;

/** A built-in command: name, description, then its argument hint and aliases if it has them. */
type Builtin = [name: string, description: string, hint?: string, aliases?: string[]];

/** Claude Code's own commands, as its menu shows them (from 2.1.286; account- and platform-gated ones left out). */
const CLAUDE_BUILTINS: Builtin[] = [
  ["add-dir", "Add a new working directory", "<path>"],
  ["advisor", "Let Claude consult a stronger model at key moments"],
  ["autocompact", "Set how full the context gets before auto-summarizing", "[auto|<tokens>]"],
  ["background", "Send this session to the background and free the terminal", "[prompt]", ["bg"]],
  ["batch", "Plan a large change; background agents each open a PR"],
  ["branch", "Create a branch of the current conversation at this point", "[name]"],
  ["btw", "Ask a quick side question without interrupting the main conversation", "[question]"],
  ["cd", "Move this session to a new working directory", "<path>"],
  ["clear", "Start a new session with empty context; the previous one stays resumable", "[name]", ["reset", "new"]],
  ["code-review", "Review the current diff for correctness bugs", "[level]"],
  ["color", "Set the prompt bar color for this session"],
  ["compact", "Free up context by summarizing the conversation so far", "[instructions]"],
  ["config", "Open settings", "[key=value]", ["settings"]],
  ["context", "Show current context usage"],
  ["copy", "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)"],
  ["daemon", "Manage background services and routines"],
  ["debug", "Turn on debug logging and investigate problems", "[issue description]"],
  ["diff", "View uncommitted changes and per-turn diffs"],
  ["doctor", "Check the health of your Claude Code installation", "", ["checkup"]],
  ["effort", "Set effort level for model usage"],
  ["exit", "Exit Claude Code", "", ["quit"]],
  ["export", "Export the current conversation to a file or clipboard", "[filename]"],
  ["fast", "Toggle fast mode"],
  ["feedback", "Send feedback to Anthropic or report a bug", "[report]", ["bug"]],
  ["focus", "Toggle focus view: just your prompt, summary, and response"],
  ["fork", "Copy this conversation into a new background session and keep working here", "[prompt]"],
  ["goal", "Set a goal Claude checks before stopping", "[<condition> | clear]"],
  ["help", "Show help and available commands"],
  ["hooks", "View hook configurations for tool events"],
  ["ide", "Manage IDE integrations and show status", "[open]"],
  ["init", "Initialize a new CLAUDE.md file with codebase documentation"],
  ["insights", "Generate a report analyzing your Claude Code sessions"],
  ["install-github-app", "Set up Claude GitHub Actions for a repository"],
  ["keybindings", "Open your keyboard shortcuts file"],
  ["login", "Sign in with your Anthropic account"],
  ["logout", "Sign out from your Anthropic account"],
  ["loop", "Run a prompt or slash command on a recurring interval", "[interval] <prompt>"],
  ["mcp", "Manage MCP servers", "[reconnect|enable|disable [<server>|all]]"],
  ["memory", "Edit CLAUDE.md files and memory settings"],
  ["model", "Set the AI model for Claude Code", "[model]"],
  ["output-style", "List output styles or switch to one", "[style]"],
  ["permissions", "Manage allow and deny tool permission rules", "", ["allowed-tools"]],
  ["plan", "Enable plan mode or view the current session plan", "[open|<description>]"],
  ["plugin", "Manage Claude Code plugins", "", ["plugins", "marketplace"]],
  ["privacy-settings", "View and update your privacy settings"],
  ["recap", "Generate a one-line session recap now"],
  ["release-notes", "View release notes"],
  ["reload-plugins", "Activate pending plugin changes in the current session"],
  ["reload-skills", "Pick up skills added or changed on disk during this session"],
  ["remote-control", "Control this session from your phone or claude.ai/code", "", ["rc"]],
  ["rename", "Rename the current conversation", "[name]", ["name"]],
  ["resume", "Resume a previous conversation", "[conversation id or search term]", ["continue"]],
  ["review", "Review a pull request", "[PR]"],
  ["rewind", "Restore the code and/or conversation to a previous point", "", ["checkpoint", "undo"]],
  ["run", "Launch this project's app to see your change working"],
  ["sandbox", "Configure sandboxed Bash"],
  ["schedule", "Create and manage scheduled remote Claude Code agents", "", ["routines"]],
  ["security-review", "Complete a security review of the pending changes on the current branch"],
  ["simplify", "Review the changed code for reuse, simplification and efficiency"],
  ["skills", "List available skills"],
  ["status", "Show version, model, account, API connectivity, and tool statuses"],
  ["statusline", "Set up Claude Code's status line"],
  ["subtask", "Send a subagent off with your full context; its result comes back here", "<task>"],
  ["tasks", "View and manage everything running in the background", "", ["bashes"]],
  ["terminal-setup", "Install the Shift+Enter key binding for newlines"],
  ["theme", "Change the theme"],
  ["todos", "List current todo items"],
  ["tui", "Set the terminal UI renderer", "[default|fullscreen]"],
  ["usage", "Show session cost, plan usage, and activity stats", "", ["cost", "stats"]],
  ["workflows", "Browse running and completed workflows"],
];

/** Codex's own commands (from codex-cli 0.159). */
const CODEX_BUILTINS: Builtin[] = [
  ["apps", "manage apps"],
  ["cd", "change the current working directory"],
  ["clear", "clear the terminal and start a new chat"],
  ["compact", "summarize conversation to prevent hitting the context limit"],
  ["copy", "copy the last response or part of it"],
  ["diff", "show git diff (including untracked files)"],
  ["exit", "exit Codex", "", ["quit"]],
  ["export", "export the conversation as markdown"],
  ["feedback", "send logs to maintainers"],
  ["fork", "fork the current chat"],
  ["goal", "set or view the goal for a long-running task"],
  ["hooks", "view and manage lifecycle hooks"],
  ["init", "create an AGENTS.md file with instructions for Codex"],
  ["logout", "log out of Codex"],
  ["mcp", "list configured MCP tools; use /mcp verbose for details"],
  ["mention", "mention a file"],
  ["model", "choose what model and reasoning effort to use"],
  ["new", "start a new chat during a conversation"],
  ["permissions", "choose what Codex is allowed to do", "", ["approvals"]],
  ["plan", "switch to Plan mode"],
  ["plugins", "browse plugins"],
  ["ps", "list background terminals"],
  ["rename", "rename the current thread"],
  ["resume", "resume a saved chat"],
  ["review", "review my current changes and find issues"],
  ["side", "start a side conversation in an ephemeral fork"],
  ["skills", "use skills to improve how Codex performs specific tasks"],
  ["status", "show current session configuration and token usage"],
  ["statusline", "configure which items appear in the status line"],
  ["stop", "stop all background terminals"],
  ["theme", "choose a syntax highlighting theme"],
  ["usage", "view account usage or use a usage limit reset"],
  ["vim", "toggle Vim mode for the composer"],
  ["worktree", "start or continue a conversation in a new worktree"],
];

const builtins = (rows: Builtin[]): SlashCommand[] =>
  rows.map(([name, description, hint, aliases]) => ({
    name,
    description,
    ...(hint ? { hint } : {}),
    ...(aliases ? { aliases } : {}),
    source: "built-in",
  }));

// Only the top of a file is read: frontmatter and the first line are all we show.
const HEAD_BYTES = 4096;
const MAX_DESCRIPTION = 200;

/**
 * The commands `agent` would offer in `cwd`. `local` says whether the pane is
 * on this machine, where its files can be read; `dirs` are its agents' folders.
 */
export async function slashCommands(agent: string | null, cwd: string | null, local: boolean, dirs: AgentDirs): Promise<SlashCommand[]> {
  if (agent === "claude") return dedupe([...builtins(CLAUDE_BUILTINS), ...(local ? await claudeFiles(dirs.claudeDir, cwd) : [])]);
  if (agent === "codex") return dedupe([...builtins(CODEX_BUILTINS), ...(local ? await codexPrompts(dirs.codexDir) : [])]);
  return [];
}

// ---------------------------------------------------------------- claude

async function claudeFiles(home: string, cwd: string | null) {
  const projects = projectDirs(cwd);
  const out = [];
  for (const dir of projects) {
    out.push(...(await commandDir(path.join(dir, ".claude", "commands"), "project")));
    out.push(...(await skillDir(path.join(dir, ".claude", "skills"), "project")));
  }
  out.push(...(await commandDir(path.join(home, "commands"), "user")));
  out.push(...(await skillDir(path.join(home, "skills"), "user")));
  out.push(...(await pluginCommands(home, cwd, projects)));
  return out;
}

/**
 * The folder the agent runs in and its parents up to the repository root:
 * a project's `.claude/` can sit at any of them. Never the home folder, whose
 * `.claude/` is the user's.
 */
function projectDirs(cwd: string | null) {
  const dirs: string[] = [];
  if (!cwd || !path.isAbsolute(cwd)) return dirs;
  const home = os.homedir();
  for (let dir = path.resolve(cwd); dir !== home; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === path.dirname(dir) || existsSync(path.join(dir, ".git"))) break;
  }
  return dirs;
}

/** `name.md` files, in subfolders too (a subfolder names a group, not the command). */
async function commandDir(dir: string, source: string, prefix = "") {
  const out = [];
  for (const file of await walk(dir, 3)) {
    if (!file.endsWith(".md")) continue;
    const head = await readHead(file);
    if (head === null) continue;
    const { meta, body } = frontmatter(head);
    out.push(command(prefix + path.basename(file, ".md"), meta.description || firstLine(body), meta["argument-hint"], source));
  }
  return out;
}

/** `<name>/SKILL.md` folders. A skill with `user-invocable: false` stays out of the menu. */
async function skillDir(dir: string, source: string, prefix = "") {
  const out = [];
  for (const entry of await list(dir)) {
    const head = await readHead(path.join(dir, entry, "SKILL.md"));
    if (head === null) continue;
    const { meta, body } = frontmatter(head);
    if (meta["user-invocable"] === "false") continue;
    out.push(command(prefix + (meta.name || entry), meta.description || firstLine(body), meta["argument-hint"], source));
  }
  return out;
}

/** ~/.claude/plugins/installed_plugins.json: each plugin's installs, for the user or for one project. */
interface InstalledPlugins {
  plugins?: Record<string, { scope?: string; projectPath?: string; installPath?: string }[]>;
}

/** A Claude Code settings file, for the plugins it turns on or off. */
interface Settings {
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Commands and skills of the enabled plugins, as `/plugin:name`. A plugin
 * installed for one project only counts inside that project; `enabledPlugins`
 * in the user's settings, then the project's, say which are on.
 */
async function pluginCommands(home: string, cwd: string | null, projects: string[]) {
  const installed = await readJson<InstalledPlugins>(path.join(home, "plugins", "installed_plugins.json"));
  if (!installed?.plugins || typeof installed.plugins !== "object") return [];
  const enabled = { ...(await readJson<Settings>(path.join(home, "settings.json")))?.enabledPlugins };
  for (const dir of [...projects].reverse()) {
    for (const f of ["settings.json", "settings.local.json"])
      Object.assign(enabled, (await readJson<Settings>(path.join(dir, ".claude", f)))?.enabledPlugins);
  }
  const here = cwd ? path.resolve(cwd) : "";
  const out = [];
  for (const [key, entries] of Object.entries(installed.plugins)) {
    if (enabled[key] !== true || !Array.isArray(entries)) continue;
    const entry = entries.find((e) => e?.scope === "user" || (typeof e?.projectPath === "string" && inside(here, e.projectPath)));
    if (typeof entry?.installPath !== "string") continue;
    const manifest = await readJson<{ name?: string }>(path.join(entry.installPath, ".claude-plugin", "plugin.json"));
    const name = typeof manifest?.name === "string" ? manifest.name : key.split("@")[0]!;
    out.push(...(await commandDir(path.join(entry.installPath, "commands"), name, `${name}:`)));
    out.push(...(await skillDir(path.join(entry.installPath, "skills"), name, `${name}:`)));
  }
  return out;
}

// ---------------------------------------------------------------- codex

/** Custom prompts in ~/.codex/prompts, run as `/prompts:<name>`. */
async function codexPrompts(home: string) {
  const out = [];
  for (const entry of await list(path.join(home, "prompts"))) {
    if (!entry.endsWith(".md")) continue;
    const head = await readHead(path.join(home, "prompts", entry));
    if (head === null) continue;
    const { meta, body } = frontmatter(head);
    out.push(command(`prompts:${entry.slice(0, -3)}`, meta.description || firstLine(body), meta["argument-hint"], "user"));
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function command(name: string, description: string | undefined, hint: string | undefined, source: string): SlashCommand {
  return { name, description: clip(description ?? ""), ...(hint ? { hint: clip(hint) } : {}), source };
}

/** The first command of a name wins: built-ins, then the project's, the user's, the plugins'. */
function dedupe(cmds: SlashCommand[]) {
  const seen = new Set<string>();
  return cmds.filter((c) => /^[\w.:-]+$/.test(c.name) && !seen.has(c.name) && seen.add(c.name));
}

/**
 * The `key: value` lines of a leading `---` block. Enough YAML for what these
 * files hold: plain or quoted one-line values, and `|` / `>` blocks.
 */
function frontmatter(text: string) {
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { meta, body: text };
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      value = block.filter(Boolean).join(" ");
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    meta[kv[1]!] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

function firstLine(body: string) {
  return (
    body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? ""
  );
}

function clip(s: string) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION - 1)}…` : s;
}

function inside(dir: string, root: string) {
  const rel = path.relative(path.resolve(root), dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function list(dir: string) {
  try {
    return (await fs.readdir(dir)).filter((e) => !e.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** Files under `dir`, `depth` folders deep at most. */
async function walk(dir: string, depth: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...(await walk(p, depth - 1)));
    else if (e.isFile() || e.isSymbolicLink()) out.push(p);
  }
  return out;
}

async function readHead(file: string) {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
