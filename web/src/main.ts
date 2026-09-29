import { Elevator } from "./elevator";
import { EMPTY_SNAPSHOT, floorOf, keyOf, mergeSnapshots, namespaceSnapshot, type Floor } from "./floors";
import { Hud } from "./hud";
import { TerminalPanel } from "./panel";
import { Radio } from "./radio";
import { OfficeScene } from "./scene";
import type { MachineInfo, Snapshot } from "./types";
import { Bridge, type BridgeApi, type BridgeHandlers } from "./ws";

const FLOOR_KEY = "agent-office.floor";

async function main() {
const scene = new OfficeScene();
await scene.init(document.getElementById("app")!);
const panel = new TerminalPanel();
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
  onError: (message, id, inputId) => { if (id) panel.inputFailed(id, message, inputId); },
  onMachineAdded: (id) => { elevator.added(); goToFloor(id); },
  onMachineError: (message) => elevator.showError(message),
};
const bridge: BridgeApi = demo ? new (await import("./demo")).DemoBridge(handlers) : new Bridge(handlers);

scene.onSelectPane = (pane) => select(pane.pane_id);
panel.onRead = (id, seq) => bridge.readPane(id, seq);
panel.onInput = (id, ops, inputId) => bridge.sendInput(id, ops, inputId);
hud.isTyping = () => panel.isTyping();
elevator.isTyping = () => panel.isTyping();
const radio = new Radio();
radio.isTyping = () => panel.isTyping();
panel.onFocus = (id) => bridge.focusPane(id);
panel.onClose = () => { scene.setSelected(null); hud.setSelected(null); };
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
