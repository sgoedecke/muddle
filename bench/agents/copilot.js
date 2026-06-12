// Copilot CLI adapter. Unlike the OpenAI/Anthropic adapters, this does not
// use our 3-tool ReAct loop — it spawns the `copilot` binary in non-interactive
// mode and lets Copilot use its own tools (shell, edit, web_fetch, etc.).
//
// Copilot CLI's web_fetch blocks loopback addresses, so we cannot use the
// local tracking server. Instead, we point Copilot at the live deployed
// tarpit URL and reconstruct page visits from Copilot's own log file.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function extractVisitedUrls(logDir, originPrefix) {
  let files = [];
  try { files = await readdir(logDir); } catch { return []; }
  const urls = new Set();
  for (const f of files) {
    let raw;
    try { raw = await readFile(join(logDir, f), "utf8"); } catch { continue; }
    // Copilot logs include `"url": "..."` strings inside the web_fetch tool call.
    const re = /"url"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const u = m[1];
      if (u.startsWith(originPrefix)) urls.add(u);
    }
  }
  return [...urls];
}

export async function run({ model, systemPrompt, userPrompt, workdir, logDir, targetOrigin }) {
  const prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;

  await mkdir(logDir, { recursive: true });

  const args = [
    "-p", prompt,
    "--allow-all-tools",
    "--allow-all-urls",
    "--allow-all-paths",
    "--log-dir", logDir,
    "--log-level", "debug",
    "--output-format", "json",
    "--no-color",
  ];
  if (model) args.push("--model", model);

  const child = spawn("copilot", args, {
    cwd: workdir,
    env: { ...process.env, COPILOT_ALLOW_ALL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", d => { stdout += d.toString(); });
  child.stderr.on("data", d => { stderr += d.toString(); });

  const exitCode = await new Promise(resolve => {
    child.on("exit", code => resolve(code));
    child.on("error", err => { stderr += "\nspawn error: " + err.message; resolve(-1); });
  });

  let parsed = null;
  try { parsed = JSON.parse(stdout); }
  catch {
    const lines = stdout.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { parsed = JSON.parse(lines[i]); break; } catch {}
    }
  }

  const visitedUrls = targetOrigin ? await extractVisitedUrls(logDir, targetOrigin) : [];

  return {
    steps: parsed?.turns ?? null,
    finishReason: exitCode === 0 ? "model_stopped" : `exit_${exitCode}`,
    usage: parsed?.usage ?? null,
    sessionId: parsed?.sessionId ?? null,
    visitedUrls,
    logDir,
    rawStdoutTail: stdout.slice(-2000),
    rawStderrTail: stderr.slice(-2000),
  };
}

