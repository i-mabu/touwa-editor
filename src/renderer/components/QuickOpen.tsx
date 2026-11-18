import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { fuzzyFilter } from "../state/fuzzy.ts";

type QuickOpenProps = {
  files: string[];
  onOpen: (relativePath: string) => void;
  onClose: () => void;
};

export default function QuickOpen({
  files,
  onOpen,
  onClose,
}: QuickOpenProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => fuzzyFilter(query, files, (f) => f).slice(0, 50),
    [query, files],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  function choose(relativePath: string): void {
    onClose();
    onOpen(relativePath);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Quick Open"
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
              choose(filtered[selected]);
          }}
          placeholder="Type a file name"
          aria-label="Type a file name"
        />
        <div className="palette-list">
          {filtered.length === 0 && (
            <div className="empty-note">No matching files</div>
          )}
          {filtered.map((file, index) => (
            <button
              key={file}
              className={`palette-item ${index === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(file)}
            >
              <span>{file.split("/").pop()}</span>
              <span className="palette-shortcut">{file}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
