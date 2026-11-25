import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  DebugBreakpoint,
  DebugFrame,
  DebugOutputEvent,
  DebugStateEvent,
  DebugVariable,
} from "./types";
import { isDebuggablePath } from "./types";

type DebugPanelProps = {
  activePath: string;
  breakpoints: DebugBreakpoint[];
  onStart: (script: string) => Promise<void>;
  onStop: () => Promise<void>;
  onResume: () => Promise<void>;
  onStepOver: () => Promise<void>;
  onStepInto: () => Promise<void>;
  onStepOut: () => Promise<void>;
  onPause: () => Promise<void>;
  onFrameVariables: (frameIndex: number) => Promise<DebugVariable[]>;
  onVariables: (variablesReference: number) => Promise<DebugVariable[]>;
  onState: (callback: (event: DebugStateEvent) => void) => () => void;
  onOutput: (callback: (event: DebugOutputEvent) => void) => () => void;
  onJumpTo: (relativePath: string, line: number, column: number) => void;
  onRemoveBreakpoint: (relativePath: string, line: number) => void;
};

type DebugStatus = "idle" | "running" | "paused" | "terminated";

const MAX_OUTPUT_CHARS = 200_000;

function VariableRows({
  variables,
  expanded,
  onToggle,
  depth,
}: {
  variables: DebugVariable[];
  expanded: Map<number, DebugVariable[]>;
  onToggle: (variable: DebugVariable) => void;
  depth: number;
}): JSX.Element {
  return (
    <>
      {variables.map((variable, index) => (
        <div key={`${variable.name}-${index}`}>
          <button
            className="debug-var"
            style={{ paddingLeft: `${6 + depth * 14}px` }}
            disabled={variable.variablesReference === 0}
            onClick={() => onToggle(variable)}
          >
            <span className="debug-var-toggle">
              {variable.variablesReference > 0
                ? expanded.has(variable.variablesReference)
                  ? "▾"
                  : "▸"
                : "·"}
            </span>
            <span className="debug-var-name">{variable.name}</span>
            <span className="debug-var-value">
              : {variable.value}
              {variable.type ? ` (${variable.type})` : ""}
            </span>
          </button>
          {variable.variablesReference > 0 &&
            expanded.has(variable.variablesReference) && (
              <VariableRows
                variables={expanded.get(variable.variablesReference) ?? []}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
        </div>
      ))}
    </>
  );
}

export default function DebugPanel({
  activePath,
  breakpoints,
  onStart,
  onStop,
  onResume,
  onStepOver,
  onStepInto,
  onStepOut,
  onPause,
  onFrameVariables,
  onVariables,
  onState,
  onOutput,
  onJumpTo,
  onRemoveBreakpoint,
}: DebugPanelProps): JSX.Element {
  const [script, setScript] = useState("");
  const [status, setStatus] = useState<DebugStatus>("idle");
  const [frames, setFrames] = useState<DebugFrame[]>([]);
  const [selectedFrame, setSelectedFrame] = useState(0);
  const [frameVariables, setFrameVariables] = useState<DebugVariable[]>([]);
  const [expanded, setExpanded] = useState<Map<number, DebugVariable[]>>(
    new Map(),
  );
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const outputRef = useRef<HTMLPreElement | null>(null);
  // 📝 App passes inline callbacks whose identity changes on every App
  // render; subscribe once and always call the latest via this ref.
  const handlersRef = useRef({ onState, onOutput, onFrameVariables });
  handlersRef.current = { onState, onOutput, onFrameVariables };
  const statusRef = useRef<DebugStatus>("idle");
  statusRef.current = status;

  useEffect(() => {
    const offState = handlersRef.current.onState((event) => {
      if (event.status === "paused") {
        const nextFrames = event.frames ?? [];
        setFrames(nextFrames);
        setSelectedFrame(0);
        setExpanded(new Map());
        setStatus("paused");
        if (nextFrames.length > 0) {
          void handlersRef.current
            .onFrameVariables(0)
            .then(setFrameVariables)
            .catch(() => setFrameVariables([]));
        } else {
          setFrameVariables([]);
        }
      } else if (event.status === "running") {
        setFrames([]);
        setFrameVariables([]);
        setExpanded(new Map());
        setStatus("running");
      } else {
        setStatus("terminated");
      }
    });
    const offOutput = handlersRef.current.onOutput((event) => {
      setOutput((prev) => (prev + event.text).slice(-MAX_OUTPUT_CHARS));
    });
    return () => {
      offState();
      offOutput();
    };
  }, []);

  // 🔗 Prefill the target from the active editor while no session runs.
  useEffect(() => {
    if (
      (statusRef.current === "idle" || statusRef.current === "terminated") &&
      isDebuggablePath(activePath)
    ) {
      setScript(activePath);
    }
  }, [activePath]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output]);

  async function start(): Promise<void> {
    const target = script.trim();
    if (!target) {
      setError("デバッグ対象のファイルを指定してください");
      return;
    }
    setError("");
    setOutput("");
    try {
      await onStart(target);
      setStatus("running");
    } catch (e) {
      setStatus("idle");
      setError(
        e instanceof Error ? e.message : "デバッグを開始できませんでした",
      );
    }
  }

  async function stop(): Promise<void> {
    try {
      await onStop();
    } catch {
      // 📝 Stopping is best-effort; the state event settles the UI.
    }
    setStatus("terminated");
  }

  async function selectFrame(index: number): Promise<void> {
    setSelectedFrame(index);
    setExpanded(new Map());
    try {
      setFrameVariables(await onFrameVariables(index));
    } catch {
      setFrameVariables([]);
    }
    const frame = frames[index];
    if (frame && frame.relativePath) {
      onJumpTo(frame.relativePath, frame.line, frame.column);
    }
  }

  async function toggleVariable(variable: DebugVariable): Promise<void> {
    const ref = variable.variablesReference;
    if (ref === 0) return;
    if (expanded.has(ref)) {
      setExpanded((prev) => {
        const next = new Map(prev);
        next.delete(ref);
        return next;
      });
      return;
    }
    try {
      const children = await onVariables(ref);
      setExpanded((prev) => new Map(prev).set(ref, children));
    } catch {
      setExpanded((prev) => new Map(prev).set(ref, []));
    }
  }

  const active = status === "running" || status === "paused";
  const statusLabel =
    status === "idle"
      ? "未開始"
      : status === "running"
        ? "実行中"
        : status === "paused"
          ? "停止中（ブレークポイント等）"
          : "終了";

  return (
    <aside className="git-panel">
      <div className="pane-title">DEBUG</div>
      <div className="git-body">
        <div className="git-actions">
          <input
            className="debug-script"
            value={script}
            placeholder="対象ファイル（例: src/main.js）"
            disabled={active}
            onChange={(e) => setScript(e.target.value)}
          />
        </div>
        <div className="git-actions">
          {!active ? (
            <button onClick={() => void start()}>▶ 開始</button>
          ) : (
            <button onClick={() => void stop()}>■ 停止</button>
          )}
          <button
            disabled={status !== "paused"}
            onClick={() => void onResume().catch(() => {})}
          >
            再開
          </button>
          <button
            disabled={status !== "running"}
            onClick={() => void onPause().catch(() => {})}
          >
            一時停止
          </button>
          <button
            disabled={status !== "paused"}
            onClick={() => void onStepOver().catch(() => {})}
          >
            オーバー
          </button>
          <button
            disabled={status !== "paused"}
            onClick={() => void onStepInto().catch(() => {})}
          >
            イン
          </button>
          <button
            disabled={status !== "paused"}
            onClick={() => void onStepOut().catch(() => {})}
          >
            アウト
          </button>
        </div>
        <div className="search-info">状態: {statusLabel}</div>
        {error && <div className="search-info">{error}</div>}
        {status === "paused" && frames.length > 0 && (
          <>
            <div className="git-section">CALL STACK</div>
            {frames.map((frame, index) => (
              <button
                key={frame.id}
                className={`git-entry ${index === selectedFrame ? "debug-frame-active" : ""}`}
                onClick={() => void selectFrame(index)}
              >
                <span className="git-path">
                  {frame.name}
                  {frame.relativePath
                    ? ` — ${frame.relativePath}:${frame.line}`
                    : ""}
                </span>
              </button>
            ))}
            <div className="git-section">VARIABLES</div>
            {frameVariables.length === 0 ? (
              <div className="search-info">変数はありません</div>
            ) : (
              <VariableRows
                variables={frameVariables}
                expanded={expanded}
                onToggle={(variable) => void toggleVariable(variable)}
                depth={0}
              />
            )}
          </>
        )}
        <div className="git-section">BREAKPOINTS</div>
        {breakpoints.length === 0 ? (
          <div className="search-info">
            エディタ左端（行番号の左）をクリックして追加します
          </div>
        ) : (
          breakpoints.map((breakpoint) => (
            <div
              key={`${breakpoint.relativePath}:${breakpoint.line}`}
              className="debug-bp-row"
            >
              <button
                className="git-entry"
                onClick={() =>
                  onJumpTo(breakpoint.relativePath, breakpoint.line, 1)
                }
              >
                <span className="git-path">
                  {breakpoint.relativePath}:{breakpoint.line}
                </span>
              </button>
              <button
                className="debug-bp-remove"
                title="削除"
                onClick={() =>
                  onRemoveBreakpoint(breakpoint.relativePath, breakpoint.line)
                }
              >
                ×
              </button>
            </div>
          ))
        )}
        <div className="git-section">OUTPUT</div>
        <pre ref={outputRef} className="task-output">
          {output}
        </pre>
        <div className="git-hint">
          Node.js ファイル（.js / .mjs / .cjs）は内蔵デバッガ、その他の拡張子は
          .touwa/debug.json に外部 DAP アダプタを設定するとデバッグできます。
        </div>
      </div>
    </aside>
  );
}
