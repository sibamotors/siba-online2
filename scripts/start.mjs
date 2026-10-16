#!/usr/bin/env node
/**
 * Production entry point for Render and VPS/PM2.
 * Loads the local .env (existing process environment wins), migrates PostgreSQL,
 * then starts Nitro in a child process with the same environment.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = resolve(root, ".env");
if (existsSync(envFile)) {
  // Native Node .env parser; Node >=22 is required by package.json.
  process.loadEnvFile(envFile);
}

let activeChild = null;
let shutdownTimer = null;
const childShutdownTimeoutMs = Number(process.env.START_CHILD_SHUTDOWN_TIMEOUT_MS || 8000);

function clearShutdownTimer() {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = null;
}

function removeSignalHandlers() {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

function mirrorChildExit(code, signal) {
  clearShutdownTimer();
  removeSignalHandlers();
  if (signal) {
    // Preserve signal-based shutdown semantics for PM2/systemd.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
}

function forwardSignal(signal) {
  const child = activeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    if (!shutdownTimer) {
      shutdownTimer = setTimeout(() => {
        if (activeChild === child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, childShutdownTimeoutMs);
      shutdownTimer.unref();
    }
  } else {
    mirrorChildExit(null, signal);
  }
}
function onSigint() {
  forwardSignal("SIGINT");
}
function onSigterm() {
  forwardSignal("SIGTERM");
}
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (err) => {
      clearShutdownTimer();
      if (activeChild === child) activeChild = null;
      rejectRun(err);
    });
    child.once("exit", (code, signal) => {
      clearShutdownTimer();
      if (activeChild === child) activeChild = null;
      resolveRun({ code, signal });
    });
  });
}

const migration = await runNode([resolve(root, "scripts/migrate.mjs")]);
if (migration.signal) mirrorChildExit(migration.code, migration.signal);
if (migration.code !== 0) process.exit(migration.code ?? 1);

const server = spawn(process.execPath, [resolve(root, ".output/server/index.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
activeChild = server;
server.once("error", (err) => {
  console.error("[start] Could not start Nitro server:", err.message);
  process.exit(1);
});
server.once("exit", (code, signal) => {
  clearShutdownTimer();
  if (activeChild === server) activeChild = null;
  // Exit the wrapper when Nitro exits, so PM2 can detect crashes and restart it.
  mirrorChildExit(code, signal);
});
