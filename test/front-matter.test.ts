import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/prompt.js";

describe("parseFrontMatter", () => {
  it("returns empty front matter when no fence is present", () => {
    const { body, frontMatter } = parseFrontMatter("# title\n\nbody\n");
    expect(frontMatter).toEqual({});
    expect(body).toBe("# title\n\nbody\n");
  });

  it("parses provider, model, and thinking", () => {
    const source = [
      "---",
      "provider: github-copilot",
      "model: claude-opus-4-7",
      "thinking: medium",
      "---",
      "",
      "# program body",
    ].join("\n");
    const { body, frontMatter } = parseFrontMatter(source);
    expect(frontMatter).toEqual({
      provider: "github-copilot",
      model: "claude-opus-4-7",
      thinking: "medium",
    });
    expect(body).toBe("# program body");
  });

  it("strips surrounding quotes from values", () => {
    const source = `---\nmodel: "anthropic/claude-opus-4-7"\n---\nbody`;
    const { frontMatter } = parseFrontMatter(source);
    expect(frontMatter.model).toBe("anthropic/claude-opus-4-7");
  });

  it("rejects unknown keys", () => {
    const source = `---\ntemperature: 0.7\n---\nbody`;
    expect(() => parseFrontMatter(source)).toThrow(/unknown key 'temperature'/);
  });

  it("rejects a fence with no close", () => {
    const source = `---\nmodel: x\nbody without close`;
    expect(() => parseFrontMatter(source)).toThrow(/no matching closing/);
  });
});
