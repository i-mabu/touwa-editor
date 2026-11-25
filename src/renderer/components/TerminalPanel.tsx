import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { TerminalDataEvent, TerminalExitEvent } from "./types";

type TerminalPanelProps = {
  onStart: () => Promise<{ id: string; shell: string; mode: "pty" | "pipe" }>;
  onWrite: (id: string, data: string) => Promise<boolean>;
  onKill: (id: string) => Promise<boolean>;
  onData: (callback: (event: TerminalDataEvent) => void) => () => void;
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
};

const MAX_OUTPUT_CHARS = 200_000;

export default function TerminalPanel({
  onStart,
  onWrite,
  onKill,
  onData,
  onExit,
}: TerminalPanelProps): JSX.Element {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shell, setShell] = useState("");
  const [mode, setMode] = useState<"pty" | "pipe">("pipe");
  const [state, setState] = useState<"starting" | "running" | "exited">(
    "starting",
  );
  const [error, setError] = useState("");
  const sessionRef = useRef<string | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const startedRef = useRef(false);
  // 📝 App passes inline callbacks whose identity changes on every App
  // render; subscribe once and always call the latest via this ref.
  const handlersRef = useRef({ onData, onExit });
  handlersRef.current = { onData, onExit };

  useEffect(() => {
    const offData = handlersRef.current.onData((event) => {
      if (event.id !== sessionRef.current) return;
      setOutput((prev) => (prev + event.text).slice(-MAX_OUTPUT_CHARS));
    });
    const offExit = handlersRef.current.onExit((event) => {
      if (event.id !== sessionRef.current) return;
      sessionRef.current = null;
      setSessionId(null);
      setState("exited");
      setOutput(
        (prev) =>
          `${prev}\n[セッションが終了しました（コード ${event.exitCode ?? "?"}）]\n`,
      );
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  async function start(): Promise<void> {
    setState("starting");
    setError("");
    try {
      const result = await onStart();
      sessionRef.current = result.id;
      setSessionId(result.id);
      setShell(result.shell);
      setMode(result.mode);
      setState("running");
    } catch (e) {
      setState("exited");
      setError(
        e instanceof Error ? e.message : "ターミナルを開始できませんでした",
      );
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
    return () => {
      if (sessionRef.current) void onKill(sessionRef.current);
    };
    // ▶️ Runs once on mount; start/onKill are stable props from App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  function submit(): void {
    if (!sessionId || state !== "running") return;
    const line = input;
    setInput("");
    if (mode === "pty") {
      // 📝 The PTY echoes input itself; Enter is CR on a terminal.
      void onWrite(sessionId, `${line}\r`).catch(() => undefined);
    } else {
      // 📝 A pipe-based shell does not echo input, so echo it locally
      // to keep the console readable.
      setOutput((prev) => `${prev}${line}\n`);
      void onWrite(sessionId, `${line}\n`).catch(() => undefined);
    }
  }

  function sendInterrupt(): void {
    if (!sessionId || state !== "running") return;
    void onWrite(sessionId, "\x03").catch(() => undefined);
  }

  return (
    <aside className="git-panel">
      <div className="pane-title">
        TERMINAL{shell ? ` — ${shell} (${mode === "pty" ? "PTY" : "パイプ"})` : ""}
      </div>
      <div className="git-body terminal-body">
        {error && <div className="search-info">{error}</div>}
        <pre ref={outputRef} className="terminal-output">
          {output}
        </pre>
        {state === "running" ? (
          <div className="terminal-input-row">
            <span className="terminal-prompt">&gt;</span>
            <input
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="コマンドを入力して Enter"
              aria-label="ターミナル入力"
            />
            {mode === "pty" && (
              <button
                className="git-row-action task-run"
                title="Ctrl+C を送信"
                onClick={sendInterrupt}
              >
                ^C
              </button>
            )}
            <button
              className="git-row-action task-run"
              title="セッションを終了"
              onClick={() => {
                if (sessionId) void onKill(sessionId);
              }}
            >
              ■
            </button>
          </div>
        ) : (
          <button disabled={state === "starting"} onClick={() => void start()}>
            {state === "starting" ? "開始中…" : "再起動"}
          </button>
        )}
      </div>
      <div className="search-hint">
        {mode === "pty"
          ? "PTY 接続です。対話プロンプトや Ctrl+C が機能します。全画面 TUI の描画には未対応です。"
          : "パイプ接続のコンソールです（PTY を利用できませんでした）。対話型の全画面プログラム（TTY が必要なもの）は動作しません。"}
      </div>
    </aside>
  );
}
