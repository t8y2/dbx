// Vite 8 probes Windows network-drive mappings with `net use` on first realpath.
// This verification checkout is on a local D: drive, and the sandbox blocks
// subprocess creation. Let Vite use its normal realpath fallback instead.
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const originalExec = childProcess.exec;
childProcess.exec = function(command, options, callback) {
  if (command === "net use") {
    const respond = typeof options === "function" ? options : callback;
    process.nextTick(() => respond(new Error("Network-drive probing unavailable"), "", ""));
    return undefined;
  }
  return originalExec.apply(this, arguments);
};
syncBuiltinESMExports();
