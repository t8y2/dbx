import { spawn } from "node:child_process";

const env = {
  ...process.env,
  RUST_LOG: process.env.RUST_LOG || "info",
};

const hasCargoWatch = await commandSucceeds("cargo", ["watch", "--version"]);

if (!hasCargoWatch) {
  console.warn(
    "cargo-watch is not installed; running dbx-web without hot reload. Install with: cargo install cargo-watch",
  );
}

const args = hasCargoWatch ? ["watch", "-x", "run -p dbx-web"] : ["run", "-p", "dbx-web"];
const child = spawn("cargo", args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

// Keep signal handling in Node so Windows does not have to parse nested shell quotes.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function commandSucceeds(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });

  return new Promise((resolve) => {
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
