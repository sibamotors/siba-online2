import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const startScript = await readFile(join(here, "start.mjs"), "utf8");

async function makeFixture(t, serverSource) {
  const root = await mkdtemp(join(tmpdir(), "sibamotor-start-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".output", "server"), { recursive: true });
  await writeFile(join(root, "scripts", "start.mjs"), startScript);
  await writeFile(join(root, "scripts", "migrate.mjs"), "process.exit(0);\n");
  await writeFile(join(root, ".output", "server", "index.mjs"), serverSource);
  return { script: join(root, "scripts", "start.mjs"), root };
}

async function waitForReady(root, timeoutMs = 2500) {
  const marker = join(root, ".ready");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(marker);
      return;
    } catch {
      await new Promise((resolveReady) => setTimeout(resolveReady, 10));
    }
  }
  throw new Error(`fake Nitro server did not become ready within ${timeoutMs}ms`);
}

function waitForExit(child, timeoutMs = 2500) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`start wrapper did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

test("start wrapper exits when Nitro exits, allowing PM2 to restart it", async (t) => {
  const { script } = await makeFixture(t, "setTimeout(() => process.exit(7), 30);\n");
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const result = await waitForExit(child);
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
});

test("start wrapper forwards SIGTERM to Nitro and preserves graceful shutdown", async (t) => {
  const { script, root } = await makeFixture(
    t,
    "import { writeFileSync } from 'node:fs'; writeFileSync('.ready', 'yes'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n",
  );
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const exitPromise = waitForExit(child);
  await waitForReady(root);
  child.kill("SIGTERM");
  const result = await exitPromise;
  // The fake Nitro server handles SIGTERM gracefully and exits with code 0.
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test("start wrapper force-stops a child that ignores shutdown", async (t) => {
  const { script, root } = await makeFixture(
    t,
    "import { writeFileSync } from 'node:fs'; writeFileSync('.ready', 'yes'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
  );
  const child = spawn(process.execPath, [script], {
    stdio: "ignore",
    env: { ...process.env, START_CHILD_SHUTDOWN_TIMEOUT_MS: "150" },
  });
  const exitPromise = waitForExit(child);
  await waitForReady(root);
  child.kill("SIGTERM");
  const result = await exitPromise;
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
});
