import { TerminalPanel } from "./panel";
import { OfficeScene } from "./scene";
import { Bridge } from "./ws";

const dot = document.getElementById("conn")!;
const connText = document.getElementById("conn-text")!;

const scene = new OfficeScene();
await scene.init(document.getElementById("app")!);
const panel = new TerminalPanel();

const bridge = new Bridge({
  onSnapshot: (s) => {
    scene.setSnapshot(s);
    panel.setSnapshot(s);
    // Deep link: ?pane=w1:p1 opens that pane's terminal on load.
    const want = new URLSearchParams(location.search).get("pane");
    if (want && !panel.selectedPaneId) {
      const p = s.panes.find((x) => x.pane_id === want);
      if (p) panel.open(p);
    }
  },
  onStatus: (ok, text) => {
    dot.className = `dot ${ok ? "ok" : "bad"}`;
    connText.textContent = text;
  },
  onPaneOutput: (id, text, rev) => panel.receive(id, text, rev),
});

scene.onSelectPane = (pane) => panel.open(pane);
panel.onRead = (id) => bridge.readPane(id);
panel.onFocus = (id) => bridge.focusPane(id);
