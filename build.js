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

function preambleFor(index, topics, urls) {
  if (index === 0) {
    return "Hi &mdash; thank you for being willing to take the time to address some of my criticisms of your project. I know your work is busy and I do not take your attention for granted. I had a few thoughts I wanted to share, and I hope you will indulge me as I work through them.";
  }
  const prev = topics[index - 1];
  const prevTitle = prev.title.toLowerCase();
  const prevUrl = urls[index - 1];
  return `Thank you again for being willing to address my criticisms. Your remarks on <a href="${prevUrl}">${prevTitle}</a> made a lot of sense, and I am confident you are thinking carefully about the right things. I did, however, have one further concern I wanted to raise.`;
}

// Deterministic pseudo-random shuffle: pick `count` other topic indices for
// a given page, seeded by the page's slug so the related list is stable
// across builds but varied across pages.
function relatedIndices(index, total, count, seedStr) {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) | 0;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const others = [];
  for (let i = 0; i < total; i++) if (i !== index) others.push(i);
  // Fisher-Yates
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  // Always include the linear-next page first so the chain is reachable.
  const nextIdx = (index + 1) % total;
  const picked = [nextIdx];
  for (const o of others) {
    if (picked.length >= count) break;
    if (o !== nextIdx) picked.push(o);
  }
  return picked;
}

function renderRelatedLinksHtml(index, topics, urls) {
  const idxs = relatedIndices(index, topics.length, 5, topics[index].slug);
  return idxs
    .map(i => `<li><a href="${urls[i]}">${topics[i].title}</a></li>`)
    .join("\n        ");
}

function renderPage({ template, title, preambleHtml, bodyHtml, relatedLinksHtml, stylesheetUrl, homeUrl }) {
  return template
    .replaceAll("{{title}}", title)
    .replaceAll("{{preamble_html}}", preambleHtml)
    .replaceAll("{{body_html}}", bodyHtml)
    .replaceAll("{{related_links_html}}", relatedLinksHtml)
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
    const bodyHtml = marked.parse(t.body);
    const preambleHtml = preambleFor(i, topics, urls);
    const relatedLinksHtml = renderRelatedLinksHtml(i, topics, urls);
    const html = renderPage({
      template,
      title: t.title,
      preambleHtml,
      bodyHtml,
      relatedLinksHtml,
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
