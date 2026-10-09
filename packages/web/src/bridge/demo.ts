// Demo mode: a stand-in for the bridge with made-up floors and agents, so the
// office runs in any browser with no Herdr and no bridge (`?demo`, or the
// static demo build, `pnpm build:demo`). Agents move through their statuses on
// their own, and the terminal panel works: Enter / Esc answers a blocked agent,
// a typed task puts an idle one to work, and shell panes run a few commands
// (including `claude` or `codex`, which sits an agent down at that desk).
// Claude panes suggest a next message when they finish, and "/" lists a few
// made-up commands.
// Build mode works too: new desks and rooms appear on the simulated floors.
// Claude and Codex desks fill their context windows as they work and compact
// when full, as the real bridge reports them. Printers print made-up edits
// while their room's agents work, over a few sheets already on the tray, and
// their uncommitted view is those edits plus a few from before the page came.

import { kindColor } from "../office/character";
import { keyOf, splitKey } from "../floors/floors";
import type { AgentStatus, DiffSheet, FileDiff, InputOp, MachineInfo, PaneInfo, RoomSpec, SlashCommand, Snapshot } from "@kauak/protocol";
import type { BridgeApi, BridgeHandlers } from "./ws";
import "./demo.css";

const COLS = 100;
const ROWS = 30;
const TICK_MS = 1000;
const MAX_LOG = 200;
const MAX_BLOCKED = 3;
const INSTALL = "npx kauak serve";
// Same rule as the bridge: `host`, `user@host` or an ~/.ssh/config alias.
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/;
// Same rule as the bridge for a new branch.
const GIT_REF = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;

// ---------------------------------------------------------------- script

type RoomSeed = { repo: string; branch: string; panes: [agent: string | null, status?: AgentStatus][] };

const FLOORS: { id: string; label: string; ssh: string | null; host: string; rooms: RoomSeed[] }[] = [
  {
    id: "local",
    label: "local",
    ssh: null,
    host: "laptop",
    rooms: [
      { repo: "kauak", branch: "main", panes: [["claude", "working"], [null]] },
      { repo: "kauak", branch: "feat/elevator", panes: [["codex", "blocked"]] },
      {
        repo: "kauak",
        branch: "fix/panel-scroll",
        panes: [
          ["claude", "done"],
          ["gemini", "working"],
        ],
      },
      { repo: "billing-api", branch: "main", panes: [["codex", "idle"], [null]] },
      {
        repo: "billing-api",
        branch: "feat/refunds",
        panes: [
          ["claude", "working"],
          ["opencode", "working"],
        ],
      },
      { repo: "docs-site", branch: "main", panes: [["cursor", "idle"]] },
    ],
  },
  {
    id: "gpu-box",
    label: "gpu-box",
    ssh: "dev@gpu-box",
    host: "gpu-box",
    rooms: [
      { repo: "llm-evals", branch: "main", panes: [["claude", "working"], ["codex", "blocked"], [null]] },
      { repo: "llm-evals", branch: "exp/long-context", panes: [["aider", "working"]] },
      {
        repo: "data-pipeline",
        branch: "main",
        panes: [
          ["claude", "idle"],
          ["gemini", "done"],
        ],
      },
    ],
  },
];

const AGENTS = ["claude", "codex", "gemini", "opencode", "aider", "cursor"];
// The agents whose context use the bridge can read (bridge/context.js), and their windows.
const WINDOW: Record<string, number> = { claude: 1_000_000, codex: 258_400 };
// What a fresh session starts with: system prompt, tools, memory files.
const BASE_CONTEXT: [number, number] = [14_000, 22_000];
const EXTRA_REPOS = ["web-app", "mobile", "infra", "search-service", "cli", "design-system"];
const BRANCHES = ["feat/onboarding", "fix/timeouts", "chore/deps", "feat/export", "fix/flaky-ci"];

const TASKS = [
  "Fix the flaky login test",
  "Add pagination to /invoices",
  "Refactor the elevator animation",
  "Document the SSH floors",
  "Speed up the snapshot diff",
  "Add retries to the webhook sender",
  "Move config to TOML",
  "Remove unused CSS",
  "Add a dark mode toggle",
  "Find the memory leak in the worker",
  "Bump dependencies and fix what breaks",
  "Test the message box",
  "Split scene.ts into modules",
  "Handle SIGTERM gracefully",
  "Profile the eval runner",
  "Cache tokenizer results",
  "Add refunds to the ledger",
];
const FILES = [
  "src/server.ts",
  "src/routes/invoices.ts",
  "web/src/scene.ts",
  "web/src/elevator.ts",
  "web/src/panel.ts",
  "test/login.test.ts",
  "README.md",
  "src/worker/queue.ts",
  "src/config.ts",
  "package.json",
  "db/migrations/0042_refunds.sql",
  "src/api/client.ts",
  "evals/runner.py",
];
const COMMANDS: [string, string][] = [
  ["pnpm test", "✓ 214 passed (3.1s)"],
  ["pnpm typecheck", "No errors"],
  ["git diff --stat", "4 files changed, 61 insertions(+), 18 deletions(-)"],
  ['rg "TODO" src', "7 matches in 4 files"],
  ["pnpm lint --fix", "Fixed 3 problems"],
  ["python -m pytest -q", "58 passed in 4.02s"],
  ["cargo check", "Finished dev profile in 2.4s"],
];
const CODE = [
  "const retries = opts.retries ?? 3;",
  "await queue.drain();",
  "if (!session) return null;",
  "return rows.map(toInvoice);",
  "timeout: 30_000,",
  'logger.warn("slow snapshot", { ms });',
  "export function fit(scene: Scene) {",
  "clock = options.clock ?? Date;",
];
const THOUGHTS = [
  "I'll start by reading how the snapshot is built.",
  "The failing test depends on wall-clock time; I'll inject a clock.",
  "Let me check where this config value is read.",
  "Running the tests to confirm the fix.",
  "That covers the happy path; now the error cases.",
  "The call sites need the new argument too.",
];
const SEARCHES = ["retries", "session.snapshot", "TODO", "fitToPanel", "webhook", "clock"];
const ASKS: [what: string, detail: string][] = [
  ["Bash command", "pnpm test --filter scene"],
  ["Bash command", "git push origin HEAD"],
  ["Edit file", "src/config.ts"],
  ["Bash command", "rm -rf node_modules/.cache"],
  ["Fetch", "https://registry.npmjs.org/ws"],
  ["Bash command", "docker compose up -d db"],
];
const SUMMARIES = [
  "Done. All tests pass and the diff is ready for review.",
  "Finished: 3 files changed, 48 insertions, 12 deletions. Tests are green.",
  "Done. I left two TODOs where the spec is unclear.",
  "All set. Typecheck and lint are clean.",
  "Done. The fix is in, with a regression test for it.",
];
// What a finished Claude pane suggests next (its dim prompt text; Tab takes it).
const SUGGESTIONS = [
  "commit this",
  "run the full test suite",
  "open a PR for it",
  "add a test for the error case",
  "update the README",
  "yes, go ahead",
  "now do the same for the other endpoints",
];
const cmd =
  (source: string) =>
  ([name, description, hint]: [string, string, string?]): SlashCommand => ({ name, description, ...(hint ? { hint } : {}), source });
const SLASH: Record<string, SlashCommand[]> = {
  claude: [
    ...(
      [
        ["clear", "Start a new session with empty context"],
        ["compact", "Free up context by summarizing the conversation so far", "[instructions]"],
        ["config", "Open settings"],
        ["context", "Show current context usage"],
        ["diff", "View uncommitted changes and per-turn diffs"],
        ["exit", "Exit Claude Code"],
        ["help", "Show help and available commands"],
        ["init", "Initialize a new CLAUDE.md file with codebase documentation"],
        ["mcp", "Manage MCP servers"],
        ["memory", "Edit CLAUDE.md files and memory settings"],
        ["model", "Set the AI model for Claude Code", "[model]"],
        ["permissions", "Manage allow and deny tool permission rules"],
        ["plan", "Enable plan mode or view the current session plan"],
        ["resume", "Resume a previous conversation"],
        ["review", "Review a pull request", "[PR]"],
        ["status", "Show version, model, account and tool statuses"],
        ["usage", "Show session cost, plan usage, and activity stats"],
      ] as [string, string, string?][]
    ).map(cmd("built-in")),
    cmd("project")(["deploy-preview", "Deploy this branch to a preview URL"]),
    cmd("user")(["standup", "Summarize yesterday's commits for standup"]),
    cmd("commit-commands")(["commit-commands:commit", "Create a git commit"]),
    cmd("commit-commands")(["commit-commands:commit-push-pr", "Commit, push, and open a PR"]),
  ],
  codex: (
    [
      ["compact", "summarize conversation to prevent hitting the context limit"],
      ["diff", "show git diff (including untracked files)"],
      ["init", "create an AGENTS.md file with instructions for Codex"],
      ["mention", "mention a file"],
      ["model", "choose what model and reasoning effort to use"],
      ["new", "start a new chat during a conversation"],
      ["permissions", "choose what Codex is allowed to do"],
      ["review", "review my current changes and find issues"],
      ["status", "show current session configuration and token usage"],
      ["exit", "exit Codex"],
    ] as [string, string, string?][]
  ).map(cmd("built-in")),
};
const VERBS = ["Thinking", "Reading", "Editing", "Testing", "Refactoring", "Pondering", "Wiring", "Tidying"];
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
// A working agent's chance, each tick, of saving a file (its room's printer prints it).
const PRINT_CHANCE = 0.07;
// Rows for made-up diffs, by kind of file.
const SNIPPETS: Record<string, string[]> = {
  ts: [
    "export async function snapshot(machine: Machine) {",
    '  const res = await machine.request("session.snapshot");',
    "  if (!res) return null;",
    "  return res.snapshot;",
    "}",
    "const retries = opts.retries ?? 3;",
    "  await queue.drain();",
    "  if (!session) return null;",
    "  return rows.map(toInvoice);",
    "  timeout: 30_000,",
    '  logger.warn("slow snapshot", { ms });',
    "export function fit(scene: Scene) {",
    "  clock = options.clock ?? Date;",
    "  for (const pane of panes) {",
    '    if (pane.agent_status === "blocked") blocked++;',
    "  }",
    'import { backoff } from "./retry";',
    "  const page = Math.max(1, Number(query.page) || 1);",
    "  expect(res.status).toBe(200);",
  ],
  py: [
    "def run(cases, model):",
    "    results = []",
    "    for case in cases:",
    "        score = grade(case, model)",
    "        results.append(score)",
    "    return results",
    "import asyncio",
    "    await asyncio.sleep(backoff)",
    "CACHE_SIZE = 4096",
    "@lru_cache(maxsize=CACHE_SIZE)",
    "def tokenize(text: str) -> list[int]:",
  ],
  md: [
    "## Remote floors",
    "Floors are saved in `~/.config/kauak/machines.json`.",
    "Run `npx kauak serve` to start the office.",
    "",
    "- **working**: typing at the desk",
    "- **blocked**: hand raised, waiting for you",
    "See the plugin guide for themes.",
  ],
  sql: [
    "CREATE TABLE refunds (",
    "  id bigserial PRIMARY KEY,",
    "  invoice_id bigint NOT NULL REFERENCES invoices(id),",
    "  amount_cents integer NOT NULL CHECK (amount_cents > 0),",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    "CREATE INDEX refunds_invoice_idx ON refunds (invoice_id);",
  ],
  json: ['  "ws": "^8.18.0",', '  "vite": "^6.0.0",', '  "typescript": "^5.6.0",', '  "test": "vitest run",', '  "build": "vite build",'],
};
const COMMITS = [
  "Merge pull request #42 from feat/refunds",
  "Retry webhooks with backoff",
  "Fix the session timer race",
  "Add pagination to invoices",
  "Bump ws to 8.18",
];

// ---------------------------------------------------------------- model

interface DemoPane {
  id: string;
  agent: string | null;
  status: AgentStatus;
  task: string;
  verb: string;
  placeholder: string;
  /** Claude's suggested next message, shown dim in its empty prompt. */
  suggestion: string;
  log: string[];
  input: string;
  ask: [string, string] | null;
  startedAt: number;
  /** When the pane may change status on its own. */
  next: number;
  /** Tokens in the agent's context window. */
  context: number;
}

/** A workspace. A `plain` one is a folder outside git (no branch, no repository). */
interface DemoRoom {
  id: string;
  number: number;
  repo: string;
  branch: string;
  dir: string;
  panes: DemoPane[];
  label?: string;
  plain?: boolean;
}

interface DemoFloor {
  info: MachineInfo;
  host: string;
  rooms: DemoRoom[];
  focused: string | null;
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);

const sgr = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const gray = sgr("90"),
  green = sgr("32"),
  red = sgr("31"),
  yellow = sgr("33"),
  blue = sgr("34"),
  bold = sgr("1");
// Dim is how agents draw placeholders.
const dim = sgr("2");
const rgb = (c: number) => sgr(`38;2;${c >> 16};${(c >> 8) & 255};${c & 255}`);

/** Codex and aider draw "•" bullets and a "›" prompt; the rest look more like Claude Code. */
const codexy = (p: DemoPane) => p.agent === "codex" || p.agent === "aider";

// ---------------------------------------------------------------- bridge

export class DemoBridge implements BridgeApi {
  private floors: DemoFloor[] = [];
  /** printer ("machine/<root>") → what is not committed there, by path */
  private worktrees = new Map<string, Map<string, FileDiff>>();

  constructor(private h: BridgeHandlers) {
    const now = Date.now();
    for (const f of FLOORS) {
      this.floors.push(this.makeFloor(f.id, f.label, f.ssh, f.host, f.rooms, now));
    }
    showCard();
    // Answer the way the bridge does: right after "connecting".
    setTimeout(() => {
      this.h.onStatus(true);
      this.pushMachines();
      for (const f of this.floors) {
        this.pushSnapshot(f);
        this.pushPrints(f);
      }
    }, 0);
    setInterval(() => this.tick(), TICK_MS);
  }

  focusPane(key: string) {
    const found = this.find(key);
    if (!found) return;
    found.floor.focused = found.pane.id;
    this.pushSnapshot(found.floor);
  }

  readPane(key: string, seq: number) {
    const found = this.find(key);
    if (!found) return;
    const p = found.pane;
    // A finished agent goes back to idle once someone has looked at it.
    if (p.status === "done") p.next = Math.min(p.next, Date.now() + 3000);
    setTimeout(() => this.h.onPaneOutput(key, screen(p, found.floor, found.room), seq), 20);
  }

  listCommands(key: string) {
    const found = this.find(key);
    if (!found) return;
    setTimeout(() => this.h.onCommands?.(key, SLASH[found.pane.agent ?? ""] ?? []), 20);
  }

  sendInput(key: string, ops: InputOp[], id: number): boolean {
    const found = this.find(key);
    if (!found) return false;
    const { floor, room, pane } = found;
    const before = snapshotKey(pane);
    for (const op of ops) {
      if ("text" in op) this.type(pane, op.text);
      else for (const k of op.keys) this.key(pane, room, floor, k);
    }
    if (snapshotKey(pane) !== before) this.pushSnapshot(floor);
    setTimeout(() => this.h.onInputAck?.(key, id), 30);
    return true;
  }

  addMachine(ssh: string, label: string): boolean {
    setTimeout(() => {
      if (!SSH_TARGET.test(ssh)) return this.h.onMachineError?.("Use an SSH host, user@host, or a Host alias from ~/.ssh/config.");
      if (this.floors.some((f) => f.info.ssh === ssh)) return this.h.onMachineError?.(`${ssh} already has a floor.`);
      const name = (label || ssh.split("@").pop() || ssh).slice(0, 40);
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "machine";
      let id = slug;
      for (let n = 2; this.floors.some((f) => f.info.id === id); n++) id = `${slug}-${n}`;
      const now = Date.now();
      const floor = this.makeFloor(id, name, ssh, ssh.split("@").pop()!, randomRooms(), now);
      floor.info.state = "connecting";
      floor.info.message = `ssh ${ssh}…`;
      this.floors.push(floor);
      this.pushMachines();
      this.h.onMachineAdded?.(id);
      // Pretend to open the tunnel.
      setTimeout(() => {
        if (!this.floors.includes(floor)) return;
        floor.info.state = "live";
        floor.info.message = "";
        this.pushMachines();
        this.pushSnapshot(floor);
        this.pushPrints(floor);
      }, 1400);
    }, 250);
    return true;
  }

  removeMachine(id: string) {
    if (id === "local") return;
    this.floors = this.floors.filter((f) => f.info.id !== id);
    this.pushMachines();
  }

  createDesk(workspace: string, agent: string | null, id: number): boolean {
    const { machine, id: roomId } = splitKey(workspace);
    setTimeout(() => {
      const floor = this.floors.find((f) => f.info.id === machine);
      const room = floor?.rooms.find((r) => r.id === roomId);
      if (!floor || !room) return this.h.onCreateError?.("That room is gone.", id);
      const n = Math.max(0, ...room.panes.map((p) => Number(p.id.split(":p")[1]) || 0)) + 1;
      this.addPane(floor, room, `${room.id}:p${n}`, agent, id);
    }, 300);
    return true;
  }

  createRoom(machine: string, spec: RoomSpec, agent: string | null, id: number): boolean {
    setTimeout(() => {
      const fail = (message: string) => this.h.onCreateError?.(message, id);
      const floor = this.floors.find((f) => f.info.id === machine);
      if (!floor) return fail("That floor is gone.");
      const cwd = spec.cwd.trim().replace(/(.)\/+$/, "$1");
      if (!cwd.startsWith("/")) return fail("Use an absolute path, like /home/dev/code/project.");
      const checkout = floor.rooms.find((r) => !r.plain && repoRoot(r) === cwd);
      const number = Math.max(0, ...floor.rooms.map((r) => r.number)) + 1;
      const base = { id: `w${number}`, number, panes: [], label: spec.label?.trim() || undefined };
      let room: DemoRoom;
      if (spec.kind === "worktree") {
        const branch = spec.branch.trim();
        if (!checkout) return fail(`fatal: not a git repository: ${cwd}`);
        if (!GIT_REF.test(branch)) return fail("Enter a branch name like feat/my-change.");
        if (floor.rooms.some((r) => r.repo === checkout.repo && r.branch === branch))
          return fail(`fatal: a branch named '${branch}' already exists`);
        const slug = branch.replace(/\//g, "-");
        room = {
          ...base,
          repo: checkout.repo,
          branch,
          dir: `/home/dev/.herdr/worktrees/${checkout.repo}/${slug}`,
          label: base.label ?? slug,
        };
      } else {
        // A repository's main checkout is a git room; any other folder is plain.
        room = checkout
          ? { ...base, repo: checkout.repo, branch: "main", dir: cwd }
          : { ...base, repo: cwd.split("/").pop() || "~", branch: "", dir: cwd, plain: true };
      }
      floor.rooms.push(room);
      this.addPane(floor, room, `${room.id}:p1`, agent, id);
    }, 500);
    return true;
  }

  requestUncommitted(printer: string, id: number): boolean {
    const { machine, id: root } = splitKey(printer);
    setTimeout(() => {
      const known = this.floors.some((f) => f.info.id === machine && f.rooms.some((r) => !r.plain && r.dir === root));
      if (!known)
        return this.h.onUncommitted?.(printer, id, { files: [], incomplete: false, error: "That room is not in a git checkout." });
      const files = [...(this.worktrees.get(printer)?.values() ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
      this.h.onUncommitted?.(printer, id, { files, incomplete: false });
    }, 350);
    return true;
  }

  /** A new shell pane in `room`; an agent, if asked for, sits down there right away. */
  private addPane(floor: DemoFloor, room: DemoRoom, paneId: string, agent: string | null, id: number) {
    const pane = newPane(paneId, null, "idle", room, floor.host, Date.now());
    pane.log = [];
    if (agent) seat(pane, agent, room);
    room.panes.push(pane);
    this.pushSnapshot(floor);
    this.h.onCreated?.(keyOf(floor.info.id, paneId), id);
  }

  // ------------------------------------------------------------ plumbing

  private pushMachines() {
    this.h.onMachines(this.floors.map((f) => ({ ...f.info })));
  }

  private pushSnapshot(f: DemoFloor) {
    if (f.info.state === "live") this.h.onSnapshot(f.info.id, snapshotOf(f));
  }

  /** What the floor's printers already printed: a few sheets in every room with agents, over edits from before. */
  private pushPrints(f: DemoFloor) {
    const now = Date.now();
    const rooms = f.rooms.filter((r) => !r.plain && r.panes.some((p) => p.agent));
    for (const r of rooms) for (let i = between(0, 3); i > 0; i--) this.record(f, fakeSheet(r, now - 3_600_000));
    const sheets = rooms.flatMap((r) => Array.from({ length: between(1, 6) }, () => fakeSheet(r, now - between(60_000, 40 * 60_000))));
    for (const s of sheets) this.record(f, s);
    this.h.onPrints?.(
      f.info.id,
      sheets.sort((a, b) => a.at - b.at),
    );
  }

  /** A made-up edit joins its room's uncommitted changes. */
  private record(f: DemoFloor, sheet: DiffSheet) {
    const key = keyOf(f.info.id, sheet.root);
    let tree = this.worktrees.get(key);
    if (!tree) this.worktrees.set(key, (tree = new Map()));
    const { id: _id, root: _root, at: _at, ...file } = sheet;
    const prev = tree.get(file.path);
    tree.set(
      file.path,
      prev ? { ...prev, added: prev.added + file.added, removed: prev.removed + file.removed, diff: `${prev.diff}\n${file.diff}` } : file,
    );
  }

  private find(key: string) {
    const { machine, id } = splitKey(key);
    const floor = this.floors.find((f) => f.info.id === machine);
    for (const room of floor?.rooms ?? []) {
      const pane = room.panes.find((p) => p.id === id);
      if (pane) return { floor: floor!, room, pane };
    }
    return null;
  }

  private makeFloor(id: string, label: string, ssh: string | null, host: string, seeds: RoomSeed[], now: number): DemoFloor {
    const rooms = seeds.map((s, i): DemoRoom => {
      const n = i + 1;
      const room: DemoRoom = {
        id: `w${n}`,
        number: n,
        repo: s.repo,
        branch: s.branch,
        panes: [],
        dir: s.branch === "main" ? `/home/dev/code/${s.repo}` : `/home/dev/code/${s.repo}/.worktrees/${s.branch.split("/").pop()}`,
      };
      room.panes = s.panes.map(([agent, status], j) => newPane(`w${n}:p${j + 1}`, agent, status ?? "idle", room, host, now));
      return room;
    });
    return {
      info: { id, label, ssh, state: "live", message: "", runtime: { name: "Herdr", version: "demo" } },
      host,
      rooms,
      focused: rooms[0]?.panes[0]?.id ?? null,
    };
  }

  // ------------------------------------------------------------ life

  private tick() {
    const now = Date.now();
    let blocked = this.floors.flatMap((f) => f.rooms.flatMap((r) => r.panes)).filter((p) => p.status === "blocked").length;
    for (const f of this.floors) {
      let changed = false;
      for (const p of f.rooms.flatMap((r) => r.panes)) {
        if (!p.agent) continue;
        if (p.status === "working" && Math.random() < 0.4) {
          addLog(p, action(p));
          if (p.agent in WINDOW) {
            think(p);
            changed = true;
          }
        }
        if (now < p.next) continue;
        changed = true;
        if (p.status === "working") {
          const r = Math.random();
          if (r < 0.25 && blocked < MAX_BLOCKED) {
            block(p, now);
            blocked++;
          } else if (r < 0.7) finish(p, now);
          else p.next = now + between(4000, 9000);
        } else if (p.status === "blocked") answer(p, true, now);
        else if (p.status === "done") setStatus(p, "idle", now);
        else startTask(p, pick(TASKS), now);
      }
      if (changed) this.pushSnapshot(f);
      if (f.info.state !== "live") continue;
      for (const r of f.rooms) {
        if (r.plain) continue;
        for (const p of r.panes) {
          if (!p.agent || p.status !== "working" || Math.random() >= PRINT_CHANCE) continue;
          const sheet = fakeSheet(r, now);
          this.record(f, sheet);
          this.h.onPrint?.(f.info.id, sheet);
        }
      }
    }
  }

  private type(p: DemoPane, text: string) {
    // A multi-line message comes as a bracketed paste (panel.ts); the demo keeps it on one line.
    text = text.replace(/\x1b\[20[01]~/g, "").replace(/\r/g, " ");
    if (text.includes("\x1b")) return; // other escape sequences: not worth simulating
    if (p.agent && p.status === "blocked") {
      const t = text.trim().toLowerCase();
      if (t === "1" || t === "y") answer(p, true, Date.now());
      else if (t === "2" || t === "n") answer(p, false, Date.now());
      return;
    }
    p.input = clip(p.input + text, 300);
    p.suggestion = "";
  }

  private key(p: DemoPane, room: DemoRoom, floor: DemoFloor, k: string) {
    const now = Date.now();
    if (k === "tab" && !p.input && p.suggestion) p.input = p.suggestion;
    else if (k === "backspace") p.input = [...p.input].slice(0, -1).join("");
    else if (k === "ctrl+u") p.input = "";
    else if (k === "enter") {
      if (!p.agent) runShell(p, room, floor);
      else if (p.status === "blocked") answer(p, true, now);
      else submit(p, room, floor, now);
    } else if (k === "esc" || k === "ctrl+c") {
      if (!p.agent) {
        if (k === "ctrl+c") {
          addLog(p, [`${shellPrompt(room, floor.host)}${p.input}^C`]);
          p.input = "";
        }
      } else if (p.status === "blocked") answer(p, false, now);
      else if (k === "ctrl+c" && p.input) p.input = "";
      else if (p.status === "working") {
        addLog(p, [gray(`  ⎿  Interrupted · what should ${p.agent} do instead?`)]);
        setStatus(p, "idle", now);
      }
    }
  }
}

// ---------------------------------------------------------------- panes

function newPane(id: string, agent: string | null, status: AgentStatus, room: DemoRoom, host: string, now: number): DemoPane {
  const p: DemoPane = {
    id,
    agent,
    status: agent ? status : "unknown",
    task: "",
    verb: pick(VERBS),
    placeholder: pick(TASKS),
    suggestion: "",
    log: [],
    input: "",
    ask: null,
    startedAt: now - between(3000, 90_000),
    next: 0,
    context: Math.round(((WINDOW[agent ?? ""] ?? 0) * between(4, 75)) / 100),
  };
  if (!agent) {
    p.log = [
      `${shellPrompt(room, host)}git pull`,
      "Already up to date.",
      `${shellPrompt(room, host)}git status --short`,
      gray(" M src/config.ts"),
    ];
    return p;
  }
  // Every agent is partway through (or just past) a task, so the roster has something to say.
  p.log = agentHeader(p, room);
  p.task = pick(TASKS);
  addLog(p, ["", bold(`▎ ${p.task}`), "", ...action(p), "", ...action(p)]);
  if (status === "blocked") block(p, now);
  else if (status === "done" || status === "idle") {
    finish(p, now);
    setStatus(p, status, now);
  } else schedule(p, now);
  // Stagger the first changes so the floor does not move in lockstep.
  p.next = now + between(2000, p.next - now + 2000);
  return p;
}

/** Starting an agent sits someone down at this desk, idle until given a task. */
function seat(p: DemoPane, agent: string, room: DemoRoom) {
  p.agent = agent;
  p.log = agentHeader(p, room);
  p.context = between(...BASE_CONTEXT);
  p.placeholder = pick(TASKS);
  setStatus(p, "idle", Date.now());
  p.next = Date.now() + 60_000; // leave the new agent for the visitor to instruct
}

function agentHeader(p: DemoPane, room: DemoRoom): string[] {
  const where = `${room.dir.replace(/^\/home\/[^/]+/, "~")}${room.branch ? ` (${room.branch})` : ""}`;
  return [`${rgb(kindColor(p.agent))(bold(`✻ ${p.agent}`))} ${gray(`· ${where}`)}`, ""];
}

function schedule(p: DemoPane, now: number) {
  const [lo, hi] =
    p.status === "working"
      ? [7000, 18_000]
      : p.status === "blocked"
        ? [30_000, 50_000]
        : p.status === "done"
          ? [8000, 18_000]
          : [8000, 25_000];
  p.next = now + between(lo, hi);
}

function setStatus(p: DemoPane, status: AgentStatus, now: number) {
  p.status = status;
  if (status !== "blocked") p.ask = null;
  if (status === "working" || status === "blocked") p.suggestion = "";
  schedule(p, now);
}

function addLog(p: DemoPane, rows: string[]) {
  p.log.push(...rows);
  if (p.log.length > MAX_LOG) p.log.splice(0, p.log.length - MAX_LOG);
}

/** A model call: the context grows, and a full window is compacted the way Claude Code and Codex do on their own. */
function think(p: DemoPane) {
  const max = WINDOW[p.agent ?? ""];
  if (!max) return;
  p.context += Math.round((max * between(5, 30)) / 1000); // 0.5-3% a call
  if (p.context < max * 0.9) return;
  p.context = between(24_000, 45_000);
  addLog(p, ["", gray(`✻ Conversation compacted · ${p.agent} summarized the session to free up context`)]);
}

function startTask(p: DemoPane, task: string, now: number) {
  p.task = clip(task, 80);
  p.verb = pick(VERBS);
  p.startedAt = now;
  addLog(p, ["", bold(`▎ ${clip(task, COLS - 4)}`), ""]);
  setStatus(p, "working", now);
}

function block(p: DemoPane, now: number) {
  p.ask = pick(ASKS);
  const [what, detail] = p.ask;
  const call = what === "Bash command" ? `Bash(${detail})` : what === "Edit file" ? `Update(${detail})` : `Fetch(${detail})`;
  addLog(p, ["", `${bullet(p, true)} ${call}`]);
  setStatus(p, "blocked", now);
}

function answer(p: DemoPane, yes: boolean, now: number) {
  if (yes) {
    const [what, detail] = p.ask ?? ["", ""];
    const result =
      what === "Edit file"
        ? `Updated ${detail} with ${plural(between(1, 9), "addition")}`
        : what === "Fetch"
          ? "Received 12.4KB (200 OK)"
          : pick(COMMANDS)[1];
    addLog(p, [gray(`  ⎿  ${result}`)]);
    setStatus(p, "working", now);
  } else {
    addLog(p, [gray(`  ⎿  Rejected · tell ${p.agent} what to do instead`)]);
    setStatus(p, "idle", now);
  }
}

function finish(p: DemoPane, now: number) {
  addLog(p, ["", `${bullet(p, false)} ${pick(SUMMARIES)}`]);
  setStatus(p, "done", now);
  if (p.agent === "claude") p.suggestion = pick(SUGGESTIONS);
}

function submit(p: DemoPane, room: DemoRoom, floor: DemoFloor, now: number) {
  const text = p.input.trim();
  p.input = "";
  if (!text) return;
  if (text === "/exit" || text === "/quit") {
    p.agent = null;
    p.status = "unknown";
    p.log = [shellPrompt(room, floor.host)];
    return;
  }
  if (text === "/clear") {
    p.log = agentHeader(p, room);
    p.context = between(...BASE_CONTEXT);
    return;
  }
  if (text === "/compact") {
    p.context = Math.min(p.context, between(24_000, 45_000));
    addLog(p, ["", gray("✻ Conversation compacted")]);
    return;
  }
  if (text.startsWith("/")) {
    const name = text.slice(1).split(/\s/)[0]!;
    const known = (SLASH[p.agent ?? ""] ?? []).some((c) => c.name === name);
    addLog(p, [
      "",
      bold(`▎ ${clip(text, COLS - 4)}`),
      gray(known ? `  ⎿  /${name} does nothing in this demo` : `  ⎿  Unknown command: /${name}`),
    ]);
    return;
  }
  // A message typed while the agent works is queued in the transcript.
  if (p.status === "working") addLog(p, ["", bold(`▎ ${clip(text, COLS - 4)}`)]);
  else startTask(p, text, now);
}

function bullet(p: DemoPane, tool: boolean): string {
  const b = codexy(p) ? "•" : "⏺";
  return tool ? green(b) : b;
}

/** A few transcript rows of the agent at work. */
function action(p: DemoPane): string[] {
  const b = bullet(p, true),
    f = pick(FILES),
    cx = codexy(p);
  const add = between(1, 40),
    del = between(0, 15);
  switch (between(0, 5)) {
    case 0:
      return cx ? [`${b} Explored`, gray(`  └ Read ${f}`)] : [`${b} Read(${f})`, gray(`  ⎿  Read ${between(40, 400)} lines`)];
    case 1:
      return [
        cx ? `${b} Edited ${f} (${green(`+${add}`)} ${red(`-${del}`)})` : `${b} Update(${f})`,
        ...(cx ? [] : [gray(`  ⎿  Updated ${f} with ${plural(add, "addition")} and ${plural(del, "removal")}`)]),
        red(`      - ${pick(CODE)}`),
        green(`      + ${pick(CODE)}`),
      ];
    case 2: {
      const [cmd, out] = pick(COMMANDS);
      return cx ? [`${b} Ran ${cmd}`, gray(`  └ ${out}`)] : [`${b} Bash(${cmd})`, gray(`  ⎿  ${out}`)];
    }
    case 3: {
      const s = pick(SEARCHES),
        n = between(2, 14);
      return cx ? [`${b} Explored`, gray(`  └ Search ${s}`)] : [`${b} Search(pattern: "${s}")`, gray(`  ⎿  Found ${n} files`)];
    }
    default:
      return [`${bullet(p, false)} ${pick(THOUGHTS)}`];
  }
}

// ---------------------------------------------------------------- shell

function shellPrompt(room: DemoRoom, host: string): string {
  return `${green(`dev@${host}`)}:${blue(room.dir.replace(/^\/home\/dev/, "~"))} ${room.branch ? `${yellow(`(${room.branch})`)} ` : ""}$ `;
}

function repoRoot(r: DemoRoom): string {
  return `/home/dev/code/${r.repo}`;
}

function runShell(p: DemoPane, room: DemoRoom, floor: DemoFloor) {
  const line = p.input;
  p.input = "";
  addLog(p, [shellPrompt(room, floor.host) + line]);
  const [cmd = "", ...args] = line.trim().split(/\s+/);
  const out = (...rows: string[]) => addLog(p, rows);
  if (!cmd) return;
  if (AGENTS.includes(cmd)) return seat(p, cmd, room);
  switch (cmd) {
    case "clear":
      p.log = [];
      return;
    case "ls":
      return out(`README.md  package.json  pnpm-lock.yaml  ${blue("src")}  ${blue("test")}  tsconfig.json`);
    case "pwd":
      return out(room.dir);
    case "whoami":
      return out("dev");
    case "date":
      return out(new Date().toString());
    case "echo":
      return out(args.join(" "));
    case "exit":
      return out("There is no way out of the office.");
    case "sudo":
      return out("dev is not in the sudoers file. This incident will be reported.");
    case "npx":
      return out(
        args[0] === "kauak"
          ? "You are already in the office. Run it on your own machine to see your real agents."
          : `npx: ${args[0] ?? ""}: not in this demo`,
      );
    case "help":
      return out("This is a demo shell. Try ls, git status, git log or clear,", `or start an agent: ${AGENTS.join(", ")}.`);
    case "git":
      if (args[0] === "status")
        return out(
          `On branch ${room.branch}`,
          `Your branch is up to date with 'origin/${room.branch}'.`,
          "",
          "Changes not staged for commit:",
          red("\tmodified:   src/config.ts"),
        );
      if (args[0] === "log") return out(...COMMITS.map((m, i) => `${yellow((0x5e1f3a7 * (i + 3)).toString(16).slice(0, 7))} ${m}`));
      if (args[0] === "branch") return out(green(`* ${room.branch}`));
      return out(`git: '${args[0] ?? ""}' is not in this demo. Try git status or git log.`);
    default:
      return out(`${cmd}: command not found (this is a demo shell; try help)`);
  }
}

// ---------------------------------------------------------------- views

/** The pane's screen as the bridge sends it: ROWS rows joined by CRLF. */
function screen(p: DemoPane, floor: DemoFloor, room: DemoRoom): string {
  const rows = p.agent ? agentScreen(p, Date.now()) : [...p.log, shellPrompt(room, floor.host) + p.input];
  const view = rows.slice(-ROWS);
  while (view.length < ROWS) view.push("");
  return view.join("\r\n");
}

function agentScreen(p: DemoPane, now: number): string[] {
  const rows = [...p.log];
  if (p.status === "working") {
    const secs = Math.max(1, Math.round((now - p.startedAt) / 1000));
    const spin = SPINNER[Math.floor(now / 150) % SPINNER.length]!;
    rows.push("", `${yellow(`${spin} ${p.verb}…`)} ${gray(`(${secs}s · ↓ ${(secs * 0.037).toFixed(1)}k tokens · esc to interrupt)`)}`);
  }
  rows.push("");
  if (p.status === "blocked" && p.ask) {
    const [what, detail] = p.ask;
    // A selector, not a text prompt: no "❯" row.
    rows.push(
      yellow("─".repeat(COLS)),
      bold(` ${what}`),
      `   ${detail}`,
      "",
      " Do you want to proceed?",
      ` ${yellow("▸ 1. Yes")}`,
      `   2. No, and tell ${p.agent} what to do differently`,
      "",
      gray(" Enter to approve · Esc to reject"),
    );
  } else {
    const prompt = codexy(p) ? "›" : "❯";
    const hint = p.status === "working" ? "type to queue a message · esc to interrupt" : "type a task and press Enter";
    rows.push(
      gray("─".repeat(COLS)),
      `${prompt} ${p.input || dim(p.status === "working" ? "" : p.suggestion || `Try "${p.placeholder.toLowerCase()}"`)}`,
      gray("─".repeat(COLS)),
      gray(`  ${hint}`),
    );
  }
  return rows;
}

/** What the snapshot shows of a pane; the floor is re-sent only when this changes. */
function snapshotKey(p: DemoPane): string {
  return `${p.agent}|${p.status}|${p.task}|${p.context}`;
}

/** The floor as the bridge would send it: a Kauak snapshot, made without any runtime behind it. */
function snapshotOf(f: DemoFloor): Snapshot {
  const focusedRoom = f.rooms.find((r) => r.panes.some((p) => p.id === f.focused)) ?? null;
  const panes: PaneInfo[] = f.rooms.flatMap((r) =>
    r.panes.map((p) => ({
      pane_id: p.id,
      workspace_id: r.id,
      focused: p.id === f.focused,
      cwd: r.dir,
      title: p.agent ? p.task || p.agent : `dev@${f.host}: ${r.dir.replace(/^\/home\/dev/, "~")}`,
      agent: p.agent,
      agent_status: p.agent ? p.status : "unknown",
      screen: { rows: ROWS, cols: COLS, exact: true },
      scrollback: false,
      context: p.agent && WINDOW[p.agent] ? { used: p.context, max: WINDOW[p.agent]! } : null,
    })),
  );
  return {
    workspaces: f.rooms.map((r) => ({
      workspace_id: r.id,
      number: r.number,
      label: r.label ?? (r.branch || r.repo),
      focused: r === focusedRoom,
      git_root: r.plain ? null : r.dir,
      repo: r.plain
        ? null
        : { key: `${f.info.id}:${r.repo}`, name: r.repo, root: repoRoot(r), checkout: r.dir, linked: r.dir !== repoRoot(r) },
    })),
    panes,
  };
}

let sheetSeq = 0;

/** A made-up edit in `room`: a hunk or two in a file, or now and then a new one. */
function fakeSheet(room: DemoRoom, at: number): DiffSheet {
  const path = pick(FILES);
  const pool = SNIPPETS[path.split(".").pop()!] ?? SNIPPETS.ts!;
  const rows = (n: number, sign: string) => Array.from({ length: n }, () => sign + pick(pool));
  const base = { id: `demo-${++sheetSeq}`, root: room.dir, path, truncated: false, at };
  if (Math.random() < 0.12) {
    const lines = rows(between(4, 14), "+");
    return { ...base, change: "added", added: lines.length, removed: 0, diff: [`@@ -0,0 +1,${lines.length} @@`, ...lines].join("\n") };
  }
  const out: string[] = [];
  let added = 0,
    removed = 0,
    at0 = between(6, 120);
  for (let h = between(1, 3); h > 0; h--) {
    const del = between(0, 4),
      add = between(del ? 0 : 1, 6);
    out.push(
      `@@ -${at0},${del + 6} +${at0 + added - removed},${add + 6} @@`,
      ...rows(3, " "),
      ...rows(del, "-"),
      ...rows(add, "+"),
      ...rows(3, " "),
    );
    added += add;
    removed += del;
    at0 += del + 6 + between(10, 60);
  }
  return { ...base, change: "modified", added, removed, diff: out.join("\n") };
}

/** Rooms for a floor added from the elevator. */
function randomRooms(): RoomSeed[] {
  const repos = [...EXTRA_REPOS].sort(() => Math.random() - 0.5).slice(0, 2);
  const status = (): AgentStatus => pick(["working", "working", "idle", "blocked", "done"]);
  return repos.flatMap((repo) =>
    ["main", pick(BRANCHES)].slice(0, between(1, 3)).map((branch) => ({
      repo,
      branch,
      panes: Array.from({ length: between(1, 4) }, (_, i) =>
        i === 0 || Math.random() < 0.75 ? [pick(AGENTS), status()] : [null],
      ) as RoomSeed["panes"],
    })),
  );
}

// ---------------------------------------------------------------- card

/** The "this is a demo, here is how to get the real thing" card (index.html). */
function showCard() {
  const card = document.getElementById("demo");
  if (!card) return;
  card.hidden = false;
  document.body.classList.add("demo-card");
  const copy = card.querySelector<HTMLElement>("[data-copy] i");
  card.querySelector("[data-copy]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
    } catch {
      return;
    }
    if (copy) {
      copy.textContent = "copied";
      setTimeout(() => {
        copy.textContent = "copy";
      }, 1500);
    }
  });
  card.querySelector("[data-close]")?.addEventListener("click", () => {
    card.hidden = true;
    document.body.classList.remove("demo-card");
  });
}
