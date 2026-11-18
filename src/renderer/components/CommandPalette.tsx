import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { fuzzyFilter } from "../state/fuzzy.ts";

export type PaletteCommand = {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
};

type CommandPaletteProps = { commands: PaletteCommand[]; onClose: () => void };

export default function CommandPalette({
  commands,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => fuzzyFilter(query, commands, (c) => c.title),
    [query, commands],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function run(command: PaletteCommand): void {
    onClose();
    command.run();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command Palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) =>
                Math.min(s + 1, Math.max(filtered.length - 1, 0)),
              );
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
            if (e.key === "Enter" && filtered[selected])
              run(filtered[selected]);
          }}
          placeholder="Type a command"
          aria-label="Type a command"
        />
        <div className="palette-list">
          {filtered.length === 0 && (
            <div className="empty-note">No matching commands</div>
          )}
          {filtered.map((command, index) => (
            <button
              key={command.id}
              className={`palette-item ${index === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(command)}
            >
              <span>{command.title}</span>
              {command.shortcut && (
                <span className="palette-shortcut">{command.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
