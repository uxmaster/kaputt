// Single-file browser entry. Bundle it with --define KAPUTT_VERSION='"<version>"': the bundle is also its own worker script,
// and requests its CSS and WASM with ?v=<version>.
import './worker.js';
export * from './widget.js';
