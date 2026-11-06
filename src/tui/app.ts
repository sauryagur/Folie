// The OpenTUI edge: layout, focus, keys and the refresh timer. All state transitions live in model.ts;
// this file only maps them onto renderables and terminal input. Needs Bun (native core).
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import { HELP, execute, parseCommand, type CommandApi } from "./commands";
import {
  fleetHeader as fleetHeaderText,
  VIEWS,
  alertBadge,
  buildInspector,
  applyPoll,
  cancelPrompt,
  confirmCancelSession,
  cycleView,
  fleetRows,
  initialState,
  openTrace,
  paneLines,
  paneTitle,
  pollFailed,
  requestCancelSession,
  select,
  setView,
  withStatus,
  type TuiState,
  type View,
} from "./model";
import { poll, type PollApi } from "./poller";
import type { FolieClient } from "../shared/client";

export interface AppDeps {
  api: PollApi & CommandApi & Partial<Pick<FolieClient, "readEvents">>;
  /** Called when the user quits. The caller owns terminal teardown. */
  onQuit: () => void;
  intervalMs?: number;
  now?: () => number;
}

export interface App {
  /** One poll and redraw. Resolves when the screen reflects the server. */
  refresh(): Promise<void>;
  state(): TuiState;
  /** Stops the refresh timer. Does not destroy the renderer. */
  stop(): void;
}

const COLORS = {
  fg: "#d8dee9",
  dim: "#7b88a1",
  accent: "#88c0d0",
  bad: "#bf616a",
  good: "#a3be8c",
  selected: "#3b4252",
};

export function createApp(renderer: CliRenderer, deps: AppDeps): App {
  const now = deps.now ?? Date.now;
  let state = initialState();
  let inputFocused = false;
  // Programmatic updates to the fleet list fire selection events; those must not be read as the user moving.
  let syncing = false;

  const layout = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const header = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    fg: COLORS.accent,
  });
  const body = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    minHeight: 0,
  });

  const fleetBox = new BoxRenderable(renderer, {
    width: 40,
    flexShrink: 0,
    borderStyle: "single",
    title: "fleet",
    flexDirection: "column",
  });
  const fleetHeader = new TextRenderable(renderer, {
    content: fleetHeaderText([]),
    height: 1,
    flexShrink: 0,
    fg: COLORS.dim,
  });
  const fleet = new SelectRenderable(renderer, {
    options: [],
    showDescription: false,
    flexGrow: 1,
    textColor: COLORS.fg,
    selectedTextColor: COLORS.accent,
    selectedBackgroundColor: COLORS.selected,
    focusedBackgroundColor: "transparent",
  });

  const paneBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 0,
    borderStyle: "single",
    title: paneTitle(state),
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const pane = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.fg,
    wrapMode: "word",
  });

  const status = new TextRenderable(renderer, {
    content: "",
    height: 1,
    flexShrink: 0,
    fg: COLORS.dim,
  });
  const input = new InputRenderable(renderer, {
    placeholder: "type a command (help), or just: submit <goal>",
    flexShrink: 0,
    width: "100%",
  });

  fleetBox.add(fleetHeader);
  fleetBox.add(fleet);
  scroll.add(pane);
  paneBox.add(scroll);
  body.add(fleetBox);
  body.add(paneBox);
  layout.add(header);
  layout.add(body);
  layout.add(status);
  layout.add(input);
  renderer.root.add(layout);
  fleet.focus();

  function draw() {
    const views = VIEWS.map((v, i) =>
      v === state.view ? `[${i + 1}:${v}]` : ` ${i + 1}:${v} `,
    ).join(" ");
    header.content = ` folie   ${views}   ✗ ${alertBadge(state.alertSignals)} (a)   ${state.connected ? "● connected" : "○ offline"}`;

    const rows = fleetRows(state.agents, now());
    fleetHeader.content = fleetHeaderText(state.agents);
    syncing = true;
    fleet.options = rows.map((r) => ({
      name: r.line,
      description: "",
      value: r.name,
    }));
    const at = rows.findIndex((r) => r.name === state.selected);
    if (at >= 0) fleet.setSelectedIndex(at);
    syncing = false;

    paneBox.title = paneTitle(state);
    pane.content = paneLines(state).join("\n");
    status.content = ` ${state.status}`;
    status.fg = state.connected ? COLORS.dim : COLORS.bad;
  }

  let inFlight = false;
  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      let result = await poll(deps.api, state);
      if (state.view === "inspector" && state.selected !== null && typeof deps.api.readEvents === "function") {
        const sessionEvents = await deps.api.readEvents({ agent: state.selected, limit: 1000 });
        result = { ...result, sessionEvents, forAgent: state.selected };
      }
      state = applyPoll(state, result);
    } catch (e) {
      state = pollFailed(state, e);
    } finally {
      inFlight = false;
    }
    draw();
  }

  function focusInput(on: boolean) {
    inputFocused = on;
    if (on) input.focus();
    else fleet.focus();
  }

  async function runCommand(text: string) {
    if (/^:?\s*cancel\s+session\b/.test(text)) {
      const inspector = buildInspector(state.selected, state.sessionEvents);
      const confirmed = /\bconfirm\b/.test(text);
      const cmd = confirmCancelSession(requestCancelSession(inspector, confirmed));
      if (!cmd.sessionId) state = withStatus(state, "cancel session: no session loaded");
      else if (!cmd.confirmed) state = withStatus(state, cancelPrompt(cmd));
      else state = withStatus(state, `cancel session confirmed (command-only) for ${cmd.agent}/${cmd.sessionId}: queueCancel has no HTTP route yet, so nothing was executed`);
      draw();
      return;
    }
    const cmd = parseCommand(text, state.selected);
    switch (cmd.kind) {
      case "error":
        state = withStatus(state, cmd.message);
        break;
      case "help":
        state = withStatus(state, HELP);
        break;
      case "quit":
        return deps.onQuit();
      case "view":
        state = setView(state, cmd.view);
        break;
      default:
        try {
          state = withStatus(state, await execute(cmd, deps.api));
        } catch (e) {
          state = withStatus(state, `${e instanceof Error ? e.message : e}`);
        }
    }
    draw();
    await refresh();
  }

  fleet.on(
    SelectRenderableEvents.SELECTION_CHANGED,
    (_i: number, option: { value?: unknown } | null) => {
      if (syncing || !option || typeof option.value !== "string") return;
      state = select(state, option.value);
      void refresh();
    },
  );

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    input.value = "";
    focusInput(false);
    if (value.trim()) void runCommand(value);
  });

  const showView = (v: View) => {
    state = setView(state, v);
    draw();
    void refresh();
  };

  renderer.keyInput.on("keypress", (key) => {
    if (inputFocused) {
      if (key.name === "escape") {
        input.value = "";
        focusInput(false);
      }
      return;
    }
    switch (key.name) {
      case "tab":
        state = cycleView(state, key.shift ? -1 : 1);
        draw();
        void refresh();
        return;
      case "pageup":
        scroll.scrollBy(-1, "viewport");
        return;
      case "pagedown":
        scroll.scrollBy(1, "viewport");
        return;
      case "q":
        return deps.onQuit();
      case "i":
        key.preventDefault();
        return showView("inspector");
      case "a":
        key.preventDefault();
        return showView("alerts");
      case "b":
        key.preventDefault();
        return showView("budgets");
      case "c":
        if (state.view === "inspector") {
          const t = openTrace(buildInspector(state.selected, state.sessionEvents));
          state = withStatus(state, t ? `⎙ trace_id: ${t.traceId} (copyable — open trace: trace ${t.traceId})` : "? trace_id: none yet");
          draw();
        }
        return;
      case "t":
        if (state.view === "inspector") {
          const t = openTrace(buildInspector(state.selected, state.sessionEvents));
          state = withStatus(state, t ? `→ open trace: trace ${t.traceId}` : "? trace_id: none yet");
          draw();
        }
        return;
      case "s":
      case "r":
        if (state.selected)
          void runCommand(`${key.name === "s" ? "suspend" : "resume"} ${state.selected}`);
        return;
    }
    if (key.sequence === ":" || key.sequence === "/") {
      key.preventDefault();
      return focusInput(true);
    }
    const n = Number(key.sequence);
    if (Number.isInteger(n) && n >= 1 && n <= VIEWS.length)
      showView(VIEWS[n - 1]!);
  });

  const timer = setInterval(() => void refresh(), deps.intervalMs ?? 1000);
  draw();

  return { refresh, state: () => state, stop: () => clearInterval(timer) };
}
