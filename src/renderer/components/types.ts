export type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
};

export type FileSnapshot = {
  content: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type SearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  lineText: string;
};

export function languageForPath(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yml":
    case "yaml":
      return "yaml";
    case "xml":
      return "xml";
    case "sh":
      return "shell";
    case "sql":
      return "sql";
    default:
      return "plaintext";
  }
}
