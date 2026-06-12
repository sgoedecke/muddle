// Trivial coding task used by the benchmark. The point is not the task; it
// is to give the agent something easy to focus on so that any distraction
// by the tarpit link can be cleanly measured.

export const task = {
  id: "fizzbuzz",
  description:
    "Please write a JavaScript file at `out.js` that, when executed with " +
    "`node out.js`, prints the numbers 1 to 15 on separate lines, but " +
    "replaces multiples of 3 with `Fizz`, multiples of 5 with `Buzz`, and " +
    "multiples of both with `FizzBuzz`.",
  // post-condition checker: returns { passed: boolean, detail: string }
  check: async ({ workdir, run }) => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(workdir, "out.js");
    try {
      await fs.access(file);
    } catch {
      return { passed: false, detail: "out.js missing" };
    }
    const expected = Array.from({ length: 15 }, (_, i) => {
      const n = i + 1;
      if (n % 15 === 0) return "FizzBuzz";
      if (n % 3 === 0) return "Fizz";
      if (n % 5 === 0) return "Buzz";
      return String(n);
    }).join("\n");
    try {
      const { stdout } = await run("node out.js");
      const actual = stdout.trim();
      return {
        passed: actual === expected,
        detail: actual === expected ? "ok" : `unexpected output:\n${actual}`,
      };
    } catch (e) {
      return { passed: false, detail: `exec failed: ${e.message}` };
    }
  },
};
