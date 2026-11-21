// Single-file browser entry: bundle it with --define KAPUTT_VERSION='"<version>"' and serve worker.js, widget.css and
// hashwx.wasm from src/ next to it; the bundle requests them with ?v=<version>.
export * from './widget.js';
