import { fileURLToPath } from "node:url";

/** Absolute root of the app, independent of the shell's current directory. */
export function projectRoot() {
  return fileURLToPath(new URL("../", import.meta.url));
}
