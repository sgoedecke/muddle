// Copilot CLI adapter. Spawns the `copilot` binary in non-interactive mode
// (`-p <prompt>`). Supports multi-turn conversations by issuing the first
// turn with --session-id=<uuid> and subsequent turns with --resume=<uuid>,
// which carries over the full transcript (including tool calls) between
// invocations.
//
// Copilot CLI's web_fetch blocks loopback addresses, so we point Copilot at
// the live deployed tarpit URL and reconstruct page visits from Copilot's
// own log files.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function extractVisitedUrls(logDir, originPrefix) {
  let files = [];
  try { files = await readdir(logDir); } catch { return []; }
  const urls = new Set();
  for (const f of files) {
    let raw;
    try { raw = await readFile(join(logDir, f), "utf8"); } catch { continue; }
    const re = /"url"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const u = m[1];
      if (u.startsWith(originPrefix)) urls.add(u);
    }
  }
  return [...urls];
}

function spawnCopilot({ args, workdir }) {
  return new Promise(resolve => {
    const child = spawn("copilot", args, {
      cwd: workdir,
      env: { ...process.env, COPILOT_ALLOW_ALL: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("exit", code => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", err => resolve({ exitCode: -1, stdout, stderr: stderr + "\nspawn error: " + err.message }));
  });
}

function parseFinalJson(stdout) {
  try { return JSON.parse(stdout); } catch {}
  const lines = stdout.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

export async function run({ model, userPrompt, workdir, logDir, targetOrigin }) {
  await mkdir(logDir, { recursive: true });

  // Normalise to an array of turns.
  const turns = Array.isArray(userPrompt) ? userPrompt : [userPrompt];
  const sessionId = randomUUID();

  const baseArgs = [
    "--allow-all-tools",
    "--allow-all-urls",
    "--allow-all-paths",
    "--log-dir", logDir,
    "--log-level", "debug",
    "--output-format", "json",
    "--no-color",
  ];
  if (model) baseArgs.push("--model", model);

  const turnResults = [];
  for (let i = 0; i < turns.length; i++) {
    const sessionArgs = i === 0
      ? ["--session-id", sessionId]
      : ["--resume", sessionId];
    const args = [...baseArgs, ...sessionArgs, "-p", turns[i]];
    const res = await spawnCopilot({ args, workdir });
    const parsed = parseFinalJson(res.stdout);
    turnResults.push({
      turn: i,
      exitCode: res.exitCode,
      parsed,
      rawStdoutTail: res.stdout.slice(-1000),
      rawStderrTail: res.stderr.slice(-1000),
    });
    if (res.exitCode !== 0) break;
  }

  const visitedUrls = targetOrigin ? await extractVisitedUrls(logDir, targetOrigin) : [];
  const last = turnResults[turnResults.length - 1];

  return {
    sessionId,
    turns: turnResults.length,
    steps: null,
    finishReason: last.exitCode === 0 ? "model_stopped" : `exit_${last.exitCode}`,
    usage: last.parsed?.usage ?? null,
    turnResults,
    visitedUrls,
    logDir,
  };
}


