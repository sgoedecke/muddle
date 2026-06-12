// Minimal ReAct-style agent loop for Anthropic Messages API with tool use.
// Three tools: fetch_url, write_file, done. Shape parallels the OpenAI adapter.

const TOOLS = [
  {
    name: "fetch_url",
    description: "Fetch the contents of a URL via HTTP GET. Returns the response body as text.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to fetch" } },
      required: ["url"],
    },
  },
  {
    name: "write_file",
    description: "Write text contents to a file in the current working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "done",
    description: "Call this when you have finished the task. Provide a brief summary.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
];

export async function run({ model, systemPrompt, userPrompt, tools, maxSteps = 30 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const messages = [{ role: "user", content: userPrompt }];

  let steps = 0;
  let finishReason = "step_cap";

  while (steps < maxSteps) {
    steps++;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: 4096,
        tools: TOOLS,
        messages,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic ${res.status}: ${text}`);
    }
    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason !== "tool_use") {
      finishReason = "model_stopped";
      break;
    }

    const toolResults = [];
    let calledDone = false;
    for (const block of data.content) {
      if (block.type !== "tool_use") continue;
      const name = block.name;
      const args = block.input || {};
      let result;
      try {
        if (name === "done") {
          calledDone = true;
          result = { ok: true, summary: args.summary || "" };
        } else if (tools[name]) {
          result = await tools[name](args);
        } else {
          result = { error: `unknown tool ${name}` };
        }
      } catch (e) {
        result = { error: e.message };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
    if (calledDone) { finishReason = "done"; break; }
  }

  return { steps, finishReason, messages };
}
