import { BuildMode } from "./build";
import { Elevator } from "./elevator";
import { EMPTY_SNAPSHOT, floorOf, keyOf, mergeSnapshots, namespaceSnapshot, type Floor } from "./floors";
import { Hud } from "./hud";
import { TerminalPanel } from "./panel";
import { Prints } from "./prints";
import { Printout } from "./printout";
import { Radio } from "./radio";
import { AppearanceSettings } from "./plugins/settings";
import { OfficeBackground } from "./plugins/background";
import { OfficeScene } from "./scene";
import type { MachineInfo, Snapshot } from "./types";
import { Bridge, type BridgeApi, type BridgeHandlers } from "./ws";

const FLOOR_KEY = "agent-office.floor";

async function main() {
const scene = new OfficeScene();
await scene.init(document.getElementById("app")!);
const background = new OfficeBackground(document.getElementById("app")!);
const appearance = new AppearanceSettings(scene, background);
await appearance.restoreBanner();
const panel = new TerminalPanel();
// Every room's printer: a sheet per file edit, picked up and read in the printout.
const prints = new Prints();
scene.prints = prints;
const printout = new Printout(prints);
scene.onOpenPrinter = (key, room, label) => printout.open(key, label, () => scene.printerTray(key, room));
printout.request = (key, id) => bridge.requestUncommitted(key, id);
const banner = document.getElementById("floor-banner")!;

// Floors in bridge order (1F first); snapshots are namespaced (see floors.ts).
let machines: MachineInfo[] = [];
const snapshots = new Map<string, Snapshot>();
const params = new URLSearchParams(location.search);
// Simulated floors and agents instead of the bridge: `?demo`, or the static demo build (`pnpm build:demo`).
const demo = import.meta.env.MODE === "demo" || params.has("demo");
let current = params.get("floor") ?? load(FLOOR_KEY) ?? "local";
// Deep link: ?pane=w1:p1 (this machine) or ?pane=<machine>/w1:p1 opens that pane's terminal on load.
let wantPane = params.get("pane");
if (wantPane && !wantPane.includes("/")) wantPane = keyOf("local", wantPane);
if (wantPane) current = floorOf(wantPane);

function floors(): Floor[] {
  return machines.map((info, i) => ({ info, number: i + 1, snapshot: snapshots.get(info.id) ?? null }));
}

function refreshHud() {
  const all = floors();
  elevator.render(all, current);
  hud.setFloors(all, current);
  panel.setSnapshot(mergeSnapshots(all));
}

function goToFloor(id: string) {
  const all = floors();
  const from = all.find((f) => f.info.id === current), to = all.find((f) => f.info.id === id);
  if (!to) return;
  const dir = from && from !== to ? Math.sign(to.number - from.number) : 0;
  current = id;
  save(FLOOR_KEY, id);
  scene.showFloor(id, to.snapshot ?? EMPTY_SNAPSHOT, dir);
  if (dir !== 0) {
    banner.innerHTML = `<b>${to.number}F</b>${escapeHtml(to.info.label)}`;
    banner.classList.remove("show");
    void banner.offsetWidth; // restart the animation
    banner.classList.add("show");
  }
  refreshHud();
}

function select(paneKey: string) {
  const floor = floorOf(paneKey);
  const p = snapshots.get(floor)?.panes.find((x) => x.pane_id === paneKey);
  if (!p) return;
  if (floor !== current) goToFloor(floor);
  panel.open(p);
  scene.setSelected(paneKey);
  scene.focusPane(paneKey);
  hud.setSelected(paneKey);
}

const hud = new Hud({
  onSelect: select,
  onFit: () => scene.fit(),
  onZoom: (f) => scene.zoomAt(f),
});

const elevator = new Elevator({
  onPick: goToFloor,
  onAdd: (ssh, label) => bridge.addMachine(ssh, label),
  onRemove: (id) => bridge.removeMachine(id),
});

const handlers: BridgeHandlers = {
  onMachines: (list) => {
    machines = list;
    const ids = new Set(list.map((m) => m.id));
    for (const id of [...snapshots.keys()]) if (!ids.has(id)) snapshots.delete(id);
    if (!ids.has(current) && list.length > 0) goToFloor(list[0]!.id);
    else { scene.showFloor(current, snapshots.get(current) ?? EMPTY_SNAPSHOT); refreshHud(); }
  },
  onSnapshot: (machine, s) => {
    snapshots.set(machine, namespaceSnapshot(machine, s));
    if (machine === current) scene.showFloor(current, snapshots.get(machine)!);
    refreshHud();
    if (wantPane && floorOf(wantPane) === machine) {
      if (snapshots.get(machine)!.panes.some((x) => x.pane_id === wantPane)) select(wantPane);
      wantPane = null;
    }
  },
  onStatus: (ok) => hud.setBridge(ok),
  onPaneOutput: (id, text, seq) => panel.receive(id, text, seq),
  onInputAck: (id, inputId) => panel.inputAcked(id, inputId),
  onCommands: (id, cmds) => panel.setCommands(id, cmds),
  onError: (message, id, inputId) => { if (id) panel.inputFailed(id, message, inputId); },
  onMachineAdded: (id) => { elevator.added(); goToFloor(id); },
  onMachineError: (message) => elevator.showError(message),
  onCreated: (pane, id) => build.created(pane, id),
  onCreateError: (message, id, pane) => build.failed(message, id, pane),
  onPrints: (machine, sheets) => prints.reset(machine, sheets),
  onPrint: (machine, sheet) => prints.add(machine, sheet),
  onUncommitted: (key, id, result) => printout.receive(key, id, result),
};
const bridge: BridgeApi = demo ? new (await import("./demo")).DemoBridge(handlers) : new Bridge(handlers);

// The bridge refreshes the snapshot before it reports a new desk, so it can be selected right away.
const build = new BuildMode({
  onToggle: (on) => scene.setBuildMode(on),
  createDesk: (workspace, agent, id) => bridge.createDesk(workspace, agent, id),
  createRoom: (machine, room, agent, id) => bridge.createRoom(machine, room, agent, id),
  onCreated: select,
});
scene.onBuild = (target, x, y) => {
  const info = machines.find((m) => m.id === current);
  if (info) build.open(target, { id: info.id, label: info.label, remote: info.ssh !== null }, x, y);
};
scene.onSelectPane = (pane) => select(pane.pane_id);
scene.onEmptyClick = () => { panel.close(); build.close(); };
panel.onRead = (id, seq, lines) => bridge.readPane(id, seq, lines);
panel.onInput = (id, ops, inputId) => bridge.sendInput(id, ops, inputId);
panel.onListCommands = (id) => bridge.listCommands(id);
// Global shortcuts stay off while the terminal or the build form has the keyboard.
const typing = () => panel.isTyping() || build.hasFocus() || appearance.isOpen() || printout.isOpen();
hud.isTyping = typing;
elevator.isTyping = typing;
build.isTyping = () => panel.isTyping() || appearance.isOpen() || printout.isOpen();
const radio = new Radio();
radio.isTyping = typing;
panel.onFocus = (id) => bridge.focusPane(id);
panel.onClose = () => { scene.setSelected(null); hud.setSelected(null); };
// A wider panel can cover the desk: bring it back into the office's visible part.
panel.onResize = () => { if (panel.selectedPaneId) scene.focusPane(panel.selectedPaneId); };
}

// localStorage can be missing or throw (private windows, blocked site data).
function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

main();
