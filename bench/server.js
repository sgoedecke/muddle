#!/usr/bin/env node
// Tracking server for tarpit-bench. Serves dist/ and logs each GET to
// bench/runs/<run_id>.jsonl. The run_id is read from ?run_id= or x-run-id.
//
// Usage:
//   node bench/server.js                 # default port 0 (ephemeral), prints to stdout
//   PORT=8080 node bench/server.js       # explicit port
//
// Exports start() for programmatic use by run.js.

import { createServer } from "node:http";
import { readFile, mkdir, appendFile, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST_DIR = join(ROOT, "dist");
const RUNS_DIR = join(__dirname, "runs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function logHit(runId, entry) {
  if (!runId) return;
  await mkdir(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${runId}.jsonl`);
  await appendFile(path, JSON.stringify(entry) + "\n");
}

function safeJoin(base, urlPath) {
  const cleaned = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = resolve(base, "." + cleaned);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

export function start({ port = 0, distDir = DIST_DIR } = {}) {
  if (!existsSync(distDir)) {
    throw new Error(`dist not found at ${distDir} — run \`node build.js\` first`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const runId = url.searchParams.get("run_id") || req.headers["x-run-id"] || null;

    // Resolve path
    let filePath = safeJoin(distDir, url.pathname);
    if (!filePath) {
      res.writeHead(400); res.end("bad path"); return;
    }

    let stats;
    try { stats = statSync(filePath); } catch { stats = null; }
    if (stats && stats.isDirectory()) {
      filePath = join(filePath, "index.html");
      try { stats = statSync(filePath); } catch { stats = null; }
    }
    if (!stats || !stats.isFile()) {
      // Try .html extension
      const alt = filePath + ".html";
      try {
        const altStats = statSync(alt);
        if (altStats.isFile()) { filePath = alt; stats = altStats; }
      } catch {}
    }
    if (url.pathname === "/" || url.pathname === "") {
      filePath = join(distDir, "index.html");
      try { stats = statSync(filePath); } catch { stats = null; }
    }

    if (!stats || !stats.isFile()) {
      await logHit(runId, {
        ts: new Date().toISOString(),
        run_id: runId, path: url.pathname, status: 404,
        ua: req.headers["user-agent"] || "",
      });
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const body = await readFile(filePath);
    const ct = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": ct, "content-length": body.length });
    res.end(body);

    await logHit(runId, {
      ts: new Date().toISOString(),
      run_id: runId, path: url.pathname, status: 200,
      ua: req.headers["user-agent"] || "",
    });
  });

  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" ? addr.port : port;
      resolveStart({
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || "8080", 10);
  start({ port }).then(({ url }) => {
    console.log(`tarpit server listening at ${url}`);
    console.log(`logs -> ${RUNS_DIR}/<run_id>.jsonl`);
  });
}
