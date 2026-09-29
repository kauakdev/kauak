import { Hud } from "./hud";
import { TerminalPanel } from "./panel";
import { OfficeScene } from "./scene";
import { Bridge } from "./ws";

async function main() {
const scene = new OfficeScene();
await scene.init(document.getElementById("app")!);
const panel = new TerminalPanel();

let latest: import("./types").Snapshot | null = null;

function select(paneId: string) {
  const p = latest?.panes.find((x) => x.pane_id === paneId);
  if (!p) return;
  panel.open(p);
  scene.setSelected(paneId);
  scene.focusPane(paneId);
  hud.setSelected(paneId);
}

const hud = new Hud({
  onSelect: select,
  onFit: () => scene.fit(),
  onZoom: (f) => scene.zoomAt(f),
});

const bridge = new Bridge({
  onSnapshot: (s) => {
    latest = s;
    scene.setSnapshot(s);
    panel.setSnapshot(s);
    hud.setSnapshot(s);
    // Deep link: ?pane=w1:p1 opens that pane's terminal on load.
    const want = new URLSearchParams(location.search).get("pane");
    if (want && !panel.selectedPaneId && s.panes.some((x) => x.pane_id === want)) select(want);
  },
  onStatus: (ok, text) => hud.setStatus(ok, text),
  onPaneOutput: (id, text, rev) => panel.receive(id, text, rev),
});

scene.onSelectPane = (pane) => select(pane.pane_id);
panel.onRead = (id) => bridge.readPane(id);
panel.onFocus = (id) => bridge.focusPane(id);
panel.onClose = () => { scene.setSelected(null); hud.setSelected(null); };
}

main();
