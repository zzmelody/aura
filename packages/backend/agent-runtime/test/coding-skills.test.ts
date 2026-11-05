import assert from "node:assert/strict";
import { test } from "node:test";
import { codingSkills } from "../src/conversations/skills.ts";

test("the composer sees only user-invocable skill summaries for its selected project", async () => {
  const signal = new AbortController().signal;
  const result = await codingSkills(
    {
      async list(options) {
        assert.equal(options?.cwd, "/selected-project");
        assert.equal(options?.signal, signal);
        return [true, false].map((userInvocable) => ({
          name: userInvocable ? "review" : "hidden",
          description: "Synthetic skill metadata",
          invocation: { userInvocable, modelInvocable: false },
          provider: "synthetic",
          source: "project-agents",
          path: "/selected-project/.agents/skills/review/SKILL.md",
        }));
      },
    },
    "/selected-project",
    signal,
  );
  assert.deepEqual(result, [
    { name: "review", description: "Synthetic skill metadata" },
  ]);
});

test("skill discovery errors reach the caller instead of becoming an empty successful catalog", async () => {
  await assert.rejects(
    codingSkills(
      {
        async list() {
          throw new Error("discovery unavailable");
        },
      },
      "/selected-project",
    ),
    /discovery unavailable/,
  );
});
