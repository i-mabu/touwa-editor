// 📝 Self-host Monaco Editor from the bundled `monaco-editor` package.
//
// @monaco-editor/react loads Monaco from a CDN by default
// (cdn.jsdelivr.net), so without this setup the packaged desktop app
// shows no editor at all while offline — and it would run whatever
// version the loader pins, not the version in package.json. Register
// the local package and its language workers with the loader before
// any <Editor> mounts.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string): Worker => {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
