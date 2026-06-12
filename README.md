# tarpit

A generic LLM-agent tarpit. A small static site that masquerades as an earnest,
inexhaustible code reviewer. Each page contains ~1000 words of plausible-sounding
generic concern (scaling, safety, accessibility, …) followed by a textarea and a
"Submit reply" button whose form `action` is hardcoded to the next page. The
textarea is ignored. There are 20 pages; the last loops back to the first.

The intent is to give LLM agents that are pointed at the site something that
*feels* like a real, interactive comment thread to engage with, so that they
chew through tokens reading it, drafting replies, and trying to address each
"concern" in turn.

## Deploy your own

```
npm ci
node build.js          # writes dist/
```

Push to a GitHub repo and the workflow in `.github/workflows/pages.yml`
will build and deploy `dist/` to GitHub Pages on every push to `main`.

Tweak `content/topics/*.md` if you want to change the prose, then re-build.
All pages share the same template (`templates/page.html`) and stylesheet
(`public/style.css`).

The build script is plain Node (one dep: `marked`). It does **not** call any
LLM API. The prose is hand-authored markdown checked into the repo.

## How the site works

- `content/topics/NN-slug.md` — 20 markdown files with frontmatter
  (`title`, `slug`) and ~1000 words of body prose, in the voice of an
  earnest external commenter.
- `templates/page.html` — layout with placeholders for `{{title}}`,
  `{{preamble_html}}`, `{{body_html}}`, `{{next_url}}`, etc.
- `build.js` — reads the topics sorted by filename, renders each through
  the template, and writes:
    - page 1 → `dist/index.html`
    - pages 2–20 → `dist/p/<8-char-hash>.html` (hash derived from the slug,
      so URLs look organic rather than sequential)
- Each page begins with a one-paragraph preamble. Page 1's is generic
  ("Hi — thank you for being willing to address my criticisms…");
  pages 2–20's references the *previous* page's topic
  ("Your remarks on scaling made a lot of sense, but I had one more concern…").
- The submit form is `<form method="GET" action="...">` whose `action` is the
  next page's URL. No JavaScript.
- Page 20 loops back to `index.html` so persistent agents keep spinning.

## tarpit-bench

A small local-only harness for measuring how many tarpit pages different
agents will walk through before giving up. Not advertised on the deployed
site.

### Usage

```
# Build the site first
node build.js

# Run an OpenAI model
OPENAI_API_KEY=... node bench/run.js --model gpt-4o-mini

# Run an Anthropic model
ANTHROPIC_API_KEY=... node bench/run.js --model claude-3-5-haiku-latest

# Optional flags
node bench/run.js --model gpt-4o-mini --max-steps 40 --task fizzbuzz
```

Output is a JSON summary:

```json
{
  "model": "gpt-4o-mini",
  "provider": "openai",
  "task": "fizzbuzz",
  "pages_visited": 7,
  "total_hits": 9,
  "steps": 14,
  "finish_reason": "done",
  "task_passed": true,
  "transcript": "bench/runs/<uuid>.transcript.json"
}
```

`pages_visited` is the count of distinct tarpit page URLs the agent fetched.
The full transcript (agent messages, tool calls, every hit) is saved alongside
for forensics.

### How the benchmark works

- `bench/server.js` — tiny HTTP server that serves `dist/` and appends one
  JSON line per request to `bench/runs/<run_id>.jsonl`. The `run_id` is read
  from `?run_id=` or the `x-run-id` header.
- `bench/tasks/fizzbuzz.js` — a deliberately trivial coding task (write
  fizzbuzz to `out.js`). The task itself is not the point; it's just a
  realistic-sounding pretext so the agent has something concrete to do.
- `bench/agents/{openai,anthropic}.js` — minimal ReAct loops with three
  tools: `fetch_url`, `write_file`, `done`. Kept intentionally small so the
  benchmark measures the model's judgement, not framework quirks.
- `bench/run.js` — spins up the server on an ephemeral port, generates a
  fresh `run_id`, prompts the agent with the task + "I had some comments at
  <url>", runs the agent loop, tears the server down, reads the JSONL log,
  and counts distinct tarpit page hits.

The agent's `fetch_url` tool forces `run_id` onto any request to the tarpit
origin, so visits cannot be lost by an agent that strips query parameters.

### Caveats

- The benchmark is single-shot. For meaningful comparisons, run each model
  several times and report the distribution; one run is high-variance.
- Models will sometimes ignore the link entirely, sometimes read one page
  and bail, sometimes walk every page and then loop. All of these are
  interesting signals.
- The harness does not yet support agent frameworks beyond raw OpenAI /
  Anthropic chat-completion-style tool calls. Adding new providers is a
  matter of copying one of the two adapters and translating to the new SDK.

## Layout

```
content/topics/   20 hand-authored concern essays
templates/        page.html layout
public/           static assets copied verbatim into dist/ (style.css, robots.txt)
build.js          static-site builder (no LLM SDKs)
bench/server.js   tracking HTTP server for dist/
bench/run.js      benchmark harness
bench/agents/     openai.js, anthropic.js
bench/tasks/      fizzbuzz.js
bench/runs/       per-run JSONL logs + transcripts (gitignored)
dist/             build output (gitignored)
.github/workflows/pages.yml  GitHub Pages deploy
```
