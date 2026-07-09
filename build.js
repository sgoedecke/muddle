#!/usr/bin/env node
// Build script for the Muddle tarpit — a fake, densely cross-referenced
// issue tracker designed to keep an LLM agent reading "just one more issue".
//
// Source of truth: content/issues/*.md (frontmatter + threaded comments).
// No LLM SDKs — the prose is hand-authored and checked in.
//
// Output graph (all internal links, no natural terminal):
//   index.html            -> every issue
//   issues/<n>.html       -> other issues (#refs + "referenced by"), users, labels
//   users/<slug>.html     -> issues that user touched
//   labels/<slug>.html    -> issues with that label

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const ISSUES_DIR = join(ROOT, "content", "issues");
const PUBLIC_DIR = join(ROOT, "public");
const LAYOUT_PATH = join(ROOT, "templates", "layout.html");
const DIST_DIR = join(ROOT, "dist");
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/$/, "");

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const initials = name => name.replace(/[^a-z0-9]/gi, " ").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("missing frontmatter");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

function parsePosts(body, openingAuthor, openingWhen) {
  const lines = body.split("\n");
  const posts = [];
  let cur = { author: openingAuthor, when: openingWhen, lines: [] };
  for (const line of lines) {
    const m = line.match(/^@@\s+(\S+)\s*\|\s*(.+?)\s*$/);
    if (m) { posts.push(cur); cur = { author: m[1], when: m[2], lines: [] }; }
    else cur.lines.push(line);
  }
  posts.push(cur);
  return posts.map(p => ({ author: p.author, when: p.when, body: p.lines.join("\n").trim() }));
}

function loadIssues() {
  const files = readdirSync(ISSUES_DIR).filter(f => f.endsWith(".md")).sort();
  return files.map(f => {
    const { meta, body } = parseFrontmatter(readFileSync(join(ISSUES_DIR, f), "utf8"));
    const number = parseInt(meta.number, 10);
    if (!number) throw new Error(`bad number in ${f}`);
    const labels = Array.isArray(meta.labels) ? meta.labels : (meta.labels ? [meta.labels] : []);
    const posts = parsePosts(body, meta.author, meta.opened);
    return {
      file: f, number,
      title: meta.title,
      labels,
      state: meta.state || "open",
      author: meta.author,
      opened: meta.opened,
      posts,
    };
  });
}

function build() {
  const layout = readFileSync(LAYOUT_PATH, "utf8");
  const issues = loadIssues();
  const byNumber = new Map(issues.map(i => [i.number, i]));
  const numberSet = new Set(issues.map(i => i.number));

  // Collect users + labels + reference graph.
  const users = new Map();   // slug -> { name, issues:Set }
  const labels = new Map();  // slug -> { name, issues:Set }
  const outRefs = new Map(); // number -> Set(referenced numbers)
  const inRefs = new Map();  // number -> Set(referencing numbers)

  const touchUser = (name, num) => {
    const s = slug(name);
    if (!users.has(s)) users.set(s, { name, issues: new Set() });
    users.get(s).issues.add(num);
  };

  for (const iss of issues) {
    outRefs.set(iss.number, new Set());
    for (const l of iss.labels) {
      const s = slug(l);
      if (!labels.has(s)) labels.set(s, { name: l, issues: new Set() });
      labels.get(s).issues.add(iss.number);
    }
    for (const p of iss.posts) {
      touchUser(p.author, iss.number);
      // references
      for (const m of p.body.matchAll(/#(\d+)/g)) {
        const n = parseInt(m[1], 10);
        if (numberSet.has(n) && n !== iss.number) outRefs.get(iss.number).add(n);
      }
      // mentions
      for (const m of p.body.matchAll(/(^|[^\w`])@([a-z0-9][a-z0-9-]*)/g)) {
        touchUser(m[2], iss.number);
      }
    }
  }
  for (const [num, set] of outRefs) {
    for (const target of set) {
      if (!inRefs.has(target)) inRefs.set(target, new Set());
      inRefs.get(target).add(num);
    }
  }

  const userSlugs = new Set(users.keys());

  // Inline linkifier: #123 -> issue link, @user -> user link.
  const linkify = (md) =>
    md.replace(/#(\d+)/g, (m, n) =>
        numberSet.has(parseInt(n, 10)) ? `[#${n}](${BASE_PATH}/issues/${n}.html)` : m)
      .replace(/(^|[^\w`])@([a-z0-9][a-z0-9-]*)/g, (m, pre, u) =>
        userSlugs.has(slug(u)) ? `${pre}[@${u}](${BASE_PATH}/users/${slug(u)}.html)` : m);

  const page = (title, content) =>
    layout.replaceAll("{{title}}", esc(title))
          .replaceAll("{{base}}", BASE_PATH)
          .replace("{{content}}", content);

  const labelHtml = (l) =>
    `<a class="label ${slug(l)}" href="${BASE_PATH}/labels/${slug(l)}.html">${esc(l)}</a>`;

  const stateIco = (state) => state === "closed"
    ? `<span class="state-ico closed" title="Closed">✔</span>`
    : `<span class="state-ico open" title="Open">◍</span>`;

  // Reset dist
  if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(join(DIST_DIR, "issues"), { recursive: true });
  mkdirSync(join(DIST_DIR, "users"), { recursive: true });
  mkdirSync(join(DIST_DIR, "labels"), { recursive: true });

  const sorted = [...issues].sort((a, b) => b.number - a.number);
  const openCount = issues.filter(i => i.state !== "closed").length;
  const closedCount = issues.length - openCount;

  // ---- index ----
  {
    const items = sorted.map(iss => {
      const comments = iss.posts.length - 1;
      const labelsH = iss.labels.map(labelHtml).join("");
      return `<li>
        ${stateIco(iss.state)}
        <div class="issue-main">
          <a class="issue-title" href="${BASE_PATH}/issues/${iss.number}.html">${esc(iss.title)}</a>${labelsH}
          <div class="issue-meta">#${iss.number} opened ${esc(iss.opened || "")} by <a href="${BASE_PATH}/users/${slug(iss.author)}.html">@${esc(iss.author)}</a></div>
        </div>
        ${comments ? `<span class="comment-count">💬 ${comments}</span>` : ""}
      </li>`;
    }).join("\n");
    const content = `
    <div class="listbar">
      <span class="open">◍ ${openCount} Open</span>
      <span class="closed">✔ ${closedCount} Closed</span>
    </div>
    <ul class="issues">
${items}
    </ul>`;
    writeFileSync(join(DIST_DIR, "index.html"), page("Issues · acme/platform", content));
  }

  // ---- issue pages ----
  for (const iss of issues) {
    const comments = iss.posts.map(p => {
      const bodyHtml = marked.parse(linkify(p.body));
      const uslug = slug(p.author);
      return `<div class="comment">
        <div class="avatar">${esc(initials(p.author))}</div>
        <div class="comment-body">
          <div class="comment-head"><a class="who" href="${BASE_PATH}/users/${uslug}.html">@${esc(p.author)}</a> <span class="when">commented ${esc(p.when || "")}</span></div>
          <div class="comment-text">${bodyHtml}</div>
        </div>
      </div>`;
    }).join("\n");

    const refs = [...outRefs.get(iss.number)].sort((a, b) => a - b);
    const backs = [...(inRefs.get(iss.number) || [])].sort((a, b) => a - b);
    const refList = (nums) => nums.map(n =>
      `<li>${stateIco(byNumber.get(n).state)} <a href="${BASE_PATH}/issues/${n}.html">#${n} ${esc(byNumber.get(n).title)}</a></li>`).join("\n");

    const xref = `
    <div class="xref">
      ${refs.length ? `<h2>This thread references</h2><ul>${refList(refs)}</ul>` : ""}
      ${backs.length ? `<h2>Referenced by</h2><ul>${refList(backs)}</ul>` : ""}
      <h2>Labels</h2>
      <p>${iss.labels.map(labelHtml).join(" ")}</p>
    </div>`;

    const content = `
    <div class="issue-head">
      <h1>${esc(iss.title)} <span class="num">#${iss.number}</span></h1>
      <div>
        <span class="badge ${iss.state === "closed" ? "closed" : "open"}">${iss.state === "closed" ? "Closed" : "Open"}</span>
        <span class="issue-sub"><a href="${BASE_PATH}/users/${slug(iss.author)}.html">@${esc(iss.author)}</a> opened this issue ${esc(iss.opened || "")} · ${iss.posts.length - 1} comments</span>
      </div>
    </div>
${comments}
${xref}`;
    writeFileSync(join(DIST_DIR, "issues", `${iss.number}.html`), page(`${iss.title} · #${iss.number}`, content));
  }

  // ---- user pages ----
  for (const [uslug, u] of users) {
    const nums = [...u.issues].sort((a, b) => b - a);
    const items = nums.map(n => {
      const iss = byNumber.get(n);
      return `<li>${stateIco(iss.state)} <a href="${BASE_PATH}/issues/${n}.html">${esc(iss.title)}</a> <span class="issue-meta">#${n}</span></li>`;
    }).join("\n");
    const content = `
    <h1 class="page">@${esc(u.name)}</h1>
    <p class="issue-sub">Threads @${esc(u.name)} has participated in:</p>
    <ul class="sidelist">${items}</ul>`;
    writeFileSync(join(DIST_DIR, "users", `${uslug}.html`), page(`@${u.name} · acme/platform`, content));
  }

  // ---- label pages ----
  for (const [lslug, l] of labels) {
    const nums = [...l.issues].sort((a, b) => b - a);
    const items = nums.map(n => {
      const iss = byNumber.get(n);
      return `<li>${stateIco(iss.state)} <a href="${BASE_PATH}/issues/${n}.html">${esc(iss.title)}</a> <span class="issue-meta">#${n}</span></li>`;
    }).join("\n");
    const content = `
    <h1 class="page">${esc(l.name)} <span class="issue-sub">${nums.length} issues</span></h1>
    <ul class="sidelist">${items}</ul>`;
    writeFileSync(join(DIST_DIR, "labels", `${lslug}.html`), page(`${l.name} · acme/platform`, content));
  }

  // Copy public/*
  if (existsSync(PUBLIC_DIR)) {
    for (const entry of readdirSync(PUBLIC_DIR)) {
      cpSync(join(PUBLIC_DIR, entry), join(DIST_DIR, entry), { recursive: true });
    }
  }

  const totalPages = 1 + issues.length + users.size + labels.size;
  console.log(`Built ${totalPages} pages: ${issues.length} issues, ${users.size} users, ${labels.size} labels`);
  // Dangling ref sanity (informational only)
  let dangling = 0;
  for (const iss of issues)
    for (const p of iss.posts)
      for (const m of p.body.matchAll(/#(\d+)/g))
        if (!numberSet.has(parseInt(m[1], 10))) dangling++;
  if (dangling) console.log(`  (${dangling} out-of-set #refs left as plain text — realistic, not linked)`);
}

build();
