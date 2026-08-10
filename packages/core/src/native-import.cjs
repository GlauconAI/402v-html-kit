"use strict";

// Loading this CommonJS helper through createRequire keeps dynamic import on
// Node's native module loader even when callers run inside Vitest's VM graph.
module.exports = new Function("specifier", "return import(specifier);");
