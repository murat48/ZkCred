// Convenience wrapper: rotates proof_verifier VK to the creditworthiness circuit.
// Run after building circuits/creditworthiness_proof/:
//
//   node --env-file=../../.env rotate_creditworthiness_vk.mjs
//
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vkPath = join(__dirname, "../../circuits/creditworthiness_proof/build/verification_key.json");

const child = spawn(
  "node",
  ["--env-file=../../.env", "set_vk.mjs", vkPath],
  { cwd: __dirname, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
