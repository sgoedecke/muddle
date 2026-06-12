#!/usr/bin/env node
// Build script for the tarpit static site.
// Reads content/topics/*.md, renders 20 pages into dist/.
// No LLM SDKs. Only `marked` for markdown -> HTML.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CONTENT_DIR = join(ROOT, "content", "topics");
const PUBLIC_DIR = join(ROOT, "public");
const TEMPLATE_PATH = join(ROOT, "templates", "page.html");
const DIST_DIR = join(ROOT, "dist");
// Site base path, e.g. "/muddle" for project-scoped GitHub Pages.
// Empty for root-served sites (custom domains, local dev).
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

function hashSlug(slug) {
  return createHash("sha256").update("tarpit:" + slug).digest("hex").slice(0, 8);
}

function loadTopics() {
  const files = readdirSync(CONTENT_DIR)
    .filter(f => f.endsWith(".md"))
    .sort();
  return files.map(f => {
    const raw = readFileSync(join(CONTENT_DIR, f), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.title || !meta.slug) throw new Error(`bad frontmatter in ${f}`);
    return { file: f, title: meta.title, slug: meta.slug, body };
  });
}

function preambleFor(index, topics) {
  if (index === 0) {
    return "Hi &mdash; thank you for being willing to take the time to address some of my criticisms of your project. I know your work is busy and I do not take your attention for granted. I had a few thoughts I wanted to share, and I hope you will indulge me as I work through them.";
  }
  const prev = topics[index - 1].title.toLowerCase();
  return `Thank you again for being willing to address my criticisms. Your remarks on <strong>${prev}</strong> made a lot of sense, and I am confident you are thinking carefully about the right things. I did, however, have one further concern I wanted to raise.`;
}

function renderPage({ template, title, preambleHtml, bodyHtml, nextUrl, stylesheetUrl, homeUrl }) {
  return template
    .replaceAll("{{title}}", title)
    .replaceAll("{{preamble_html}}", preambleHtml)
    .replaceAll("{{body_html}}", bodyHtml)
    .replaceAll("{{next_url}}", nextUrl)
    .replaceAll("{{stylesheet_url}}", stylesheetUrl)
    .replaceAll("{{home_url}}", homeUrl);
}

function build() {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const topics = loadTopics();
  if (topics.length !== 20) {
    console.warn(`warning: expected 20 topics, found ${topics.length}`);
  }

  // Reset dist/
  if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  mkdirSync(join(DIST_DIR, "p"), { recursive: true });

  // Compute URL for each page.
  // Page 0 -> /index.html. Pages 1..n-1 -> /p/<hash>.html
  const urls = topics.map((t, i) => i === 0 ? `${BASE_PATH}/index.html` : `${BASE_PATH}/p/${hashSlug(t.slug)}.html`);

  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const nextUrl = i < topics.length - 1 ? urls[i + 1] : urls[0]; // loop back from last page
    const bodyHtml = marked.parse(t.body);
    const preambleHtml = preambleFor(i, topics);
    const html = renderPage({
      template,
      title: t.title,
      preambleHtml,
      bodyHtml,
      nextUrl,
      stylesheetUrl: `${BASE_PATH}/style.css`,
      homeUrl: `${BASE_PATH}/index.html`,
    });
    const outPath = i === 0
      ? join(DIST_DIR, "index.html")
      : join(DIST_DIR, "p", `${hashSlug(t.slug)}.html`);
    writeFileSync(outPath, html);
  }

  // Copy public/*
  if (existsSync(PUBLIC_DIR)) {
    for (const entry of readdirSync(PUBLIC_DIR)) {
      cpSync(join(PUBLIC_DIR, entry), join(DIST_DIR, entry), { recursive: true });
    }
  }

  console.log(`Built ${topics.length} pages into ${DIST_DIR}`);
  for (let i = 0; i < topics.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${urls[i]}  (${topics[i].title})`);
  }
}

build();
