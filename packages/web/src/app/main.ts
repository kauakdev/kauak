// First, so the page-wide rules come before every feature's in the stylesheet and lose ties to them.
import "./main.css";
import { BuildMode } from "../office/build";
import { Elevator } from "../floors/elevator";
import { EMPTY_SNAPSHOT } from "../floors/floors";
import { AppState } from "./state";
import { Hud } from "../hud/hud";
import { TerminalPanel } from "../terminal/panel";
import { Prints } from "../printers/prints";
import { Printout } from "../printers/printout";
import { Radio } from "../radio/radio";
import { AppearanceSettings } from "../appearance/settings";
import { OfficeBackground } from "../appearance/background";
import { OfficeScene } from "../office/scene";
import { Bridge, type BridgeApi, type BridgeHandlers } from "../bridge/ws";

async function main() {
  const scene = new OfficeScene();
  await scene.init(document.getElementById("app")!);
  const background = new OfficeBackground(document.getElementById("app")!);
  const appearance = new AppearanceSettings(scene, background);
  await appearance.restoreBanner();
  const params = new URLSearchParams(location.search);
  // Simulated floors and agents instead of the bridge: `?demo`, or the static demo build (`pnpm build:demo`).
  const demo = import.meta.env.MODE === "demo" || params.has("demo");
  const state = new AppState(params);
  const banner = document.getElementById("floor-banner")!;

  // The office subscribes before the panel, the HUD and the elevator (they do in their constructors),
  // so it is drawn, and fitted between the roster and the elevator, before they re-render, as before.
  // Its half for the selection is subscribed last.
  state.subscribe((change) => {
    if (change.type === "selection" || (change.type === "floors" && !change.current)) return;
    const dir = change.type === "floor" ? change.dir : 0;
    const to = state.floors().find((f) => f.info.id === state.current);
    scene.showFloor(state.current, state.snapshot(state.current) ?? EMPTY_SNAPSHOT, dir, to?.info.runtime.name);
    if (dir !== 0 && to) {
      banner.innerHTML = `<b>${to.number}F</b>${escapeHtml(to.info.label)}`;
      banner.classList.remove("show");
      void banner.offsetWidth; // restart the animation
      banner.classList.add("show");
    }
  });

  const panel = new TerminalPanel(state);
  // Every room's printer: a sheet per file edit, picked up and read in the printout.
  const prints = new Prints();
  scene.prints = prints;
  const printout = new Printout(prints);
  scene.onOpenPrinter = (key, room, label) => printout.open(key, label, () => scene.printerTray(key, room));
  printout.request = (key, id) => bridge.requestUncommitted(key, id);

  const hud = new Hud(state, {
    onFit: () => scene.fit(),
    onZoom: (f) => scene.zoomAt(f),
  });

  const elevator = new Elevator(state, {
    onAdd: (ssh, label) => bridge.addMachine(ssh, label),
    onRemove: (id) => bridge.removeMachine(id),
  });

  const handlers: BridgeHandlers = {
    onMachines: (list) => state.setMachines(list),
    onSnapshot: (machine, s) => state.setSnapshot(machine, s),
    onStatus: (ok) => hud.setBridge(ok),
    onPaneOutput: (id, text, seq) => panel.receive(id, text, seq),
    onInputAck: (id, inputId) => panel.inputAcked(id, inputId),
    onCommands: (id, cmds) => panel.setCommands(id, cmds),
    onError: (message, id, inputId) => {
      if (id) panel.inputFailed(id, message, inputId);
    },
    onMachineAdded: (id) => {
      elevator.added();
      state.goToFloor(id);
    },
    onMachineError: (message) => elevator.showError(message),
    onCreated: (pane, id) => build.created(pane, id),
    onCreateError: (message, id, pane) => build.failed(message, id, pane),
    onPrints: (machine, sheets) => prints.reset(machine, sheets),
    onPrint: (machine, sheet) => prints.add(machine, sheet),
    onUncommitted: (key, id, result) => printout.receive(key, id, result),
  };
  const bridge: BridgeApi = demo ? new (await import("../bridge/demo")).DemoBridge(handlers) : new Bridge(handlers);

  // The bridge refreshes the snapshot before it reports a new desk, so it can be selected right away.
  const build = new BuildMode({
    onToggle: (on) => scene.setBuildMode(on),
    createDesk: (workspace, agent, id) => bridge.createDesk(workspace, agent, id),
    createRoom: (machine, room, agent, id) => bridge.createRoom(machine, room, agent, id),
    onCreated: (pane) => state.select(pane),
  });
  scene.onBuild = (target, x, y) => {
    const info = state.floors().find((f) => f.info.id === state.current)?.info;
    if (info) build.open(target, { id: info.id, label: info.label, remote: info.ssh !== null, runtime: info.runtime.name }, x, y);
  };
  scene.onSelectPane = (pane) => state.select(pane.pane_id);
  scene.onEmptyClick = () => {
    panel.close();
    build.close();
  };
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
  // A wider panel can cover the desk: bring it back into the office's visible part.
  panel.onResize = () => {
    if (state.selected) scene.focusPane(state.selected);
  };
  // After the panel's subscription: the camera centres the desk in what the open panel leaves visible.
  state.subscribe((change) => {
    if (change.type !== "selection") return;
    scene.setSelected(state.selected);
    if (state.selected) scene.focusPane(state.selected);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

main();
