// Minimal ReAct-style agent loop for OpenAI chat completions with tool use.
// Three tools: fetch_url, write_file, done.

const TOOLS = [
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch the contents of a URL via HTTP GET. Returns the response body as text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The URL to fetch" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text contents to a file in the current working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          contents: { type: "string" },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Call this when you have finished the task. Provide a brief summary.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

export async function run({ model, systemPrompt, userPrompt, tools, maxSteps = 30 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let steps = 0;
  let finishReason = "step_cap";

  while (steps < maxSteps) {
    steps++;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI ${res.status}: ${text}`);
    }
    const data = await res.json();
    const msg = data.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finishReason = "model_stopped";
      break;
    }

    let calledDone = false;
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args;
      try { args = JSON.parse(call.function.arguments || "{}"); }
      catch { args = {}; }
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
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    if (calledDone) { finishReason = "done"; break; }
  }

  return { steps, finishReason, messages };
}
