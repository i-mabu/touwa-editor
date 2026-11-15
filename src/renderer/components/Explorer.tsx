import { useEffect, useState } from "react";
import type { FileEntry } from "./types";

type ExplorerProps = {
  rootName: string;
  entries: FileEntry[];
  activePath: string;
  onOpenFile: (entry: FileEntry) => void;
  onListDir: (relativeDir: string) => Promise<FileEntry[]>;
  onCreate: (kind: "file" | "directory", parentDir: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
};

type MenuState = { x: number; y: number; entry: FileEntry | null };

function TreeNode(props: {
  entry: FileEntry;
  depth: number;
  activePath: string;
  onOpenFile: (entry: FileEntry) => void;
  onListDir: (relativeDir: string) => Promise<FileEntry[]>;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}): JSX.Element {
  const { entry, depth, activePath, onOpenFile, onListDir, onContextMenu } =
    props;
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle(): Promise<void> {
    if (entry.kind !== "directory") {
      onOpenFile(entry);
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (children === null) {
      setLoading(true);
      try {
        setChildren(await onListDir(entry.relativePath));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  }

  return (
    <div>
      <button
        className={`file-entry ${activePath === entry.relativePath ? "selected" : ""}`}
        style={{ paddingLeft: 14 + depth * 14 }}
        onClick={() => void toggle()}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        {entry.kind === "directory" ? (expanded ? "▾" : "▸") : "·"} {entry.name}
        {loading ? " …" : ""}
      </button>
      {entry.kind === "directory" && expanded && children !== null && (
        <div>
          {children.length === 0 && <div className="empty-note">（空）</div>}
          {children.map((child) => (
            <TreeNode
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onListDir={onListDir}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Explorer({
  rootName,
  entries,
  activePath,
  onOpenFile,
  onListDir,
  onCreate,
  onRename,
  onDelete,
}: ExplorerProps): JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  function openMenu(e: React.MouseEvent, entry: FileEntry | null): void {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  const menuDir =
    menu?.entry?.kind === "directory"
      ? menu.entry.relativePath
      : menu?.entry
        ? menu.entry.relativePath.split("/").slice(0, -1).join("/")
        : "";

  return (
    <aside className="explorer" onContextMenu={(e) => openMenu(e, null)}>
      <div className="pane-title">
        EXPLORER
        <span className="pane-actions">
          <button title="New File" onClick={() => onCreate("file", "")}>
            ＋🗎
          </button>
          <button title="New Folder" onClick={() => onCreate("directory", "")}>
            ＋🗀
          </button>
        </span>
      </div>
      <div className="root-name">{rootName}</div>
      {entries.length === 0 && (
        <div className="empty-note">ファイルがありません</div>
      )}
      {entries.map((entry) => (
        <TreeNode
          key={entry.relativePath}
          entry={entry}
          depth={0}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onListDir={onListDir}
          onContextMenu={openMenu}
        />
      ))}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={() => {
              setMenu(null);
              onCreate("file", menuDir);
            }}
          >
            New File
          </button>
          <button
            onClick={() => {
              setMenu(null);
              onCreate("directory", menuDir);
            }}
          >
            New Folder
          </button>
          {menu.entry && (
            <>
              <button
                onClick={() => {
                  setMenu(null);
                  onRename(menu.entry!);
                }}
              >
                Rename
              </button>
              <button
                onClick={() => {
                  setMenu(null);
                  onDelete(menu.entry!);
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
