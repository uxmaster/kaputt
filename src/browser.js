// Single-file browser entry. Bundle it with --format iife --define KAPUTT_VERSION='"<version>"': the bundle is a classic script and its own worker script,
// and requests its CSS and WASM with ?v=<version>.
import './worker.js';
export * from './widget.js';
