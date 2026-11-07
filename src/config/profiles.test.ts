import { describe, expect, test } from "bun:test";
import { interpolateProfile, deepMergeConfig } from "./profiles.js";
import type { WorkflowConfig } from "./types.js";

// ── interpolateProfile ───────────────────────────────────────────

describe("interpolateProfile", () => {
  test("replaces simple profile references", () => {
    const result = interpolateProfile(
      "project: ${profile.project_slug}",
      { project_slug: "my-proj" }
    );
    expect(result).toBe("project: my-proj");
  });

  test("replaces multiple references", () => {
    const result = interpolateProfile(
      "${profile.a} and ${profile.b}",
      { a: "foo", b: "bar" }
    );
    expect(result).toBe("foo and bar");
  });

  test("replaces nested references", () => {
    const result = interpolateProfile(
      "key: ${profile.db.host}",
      { db: { host: "localhost" } }
    );
    expect(result).toBe("key: localhost");
  });

  test("throws on unresolved reference", () => {
    expect(() =>
      interpolateProfile("${profile.missing}", {})
    ).toThrow("Unresolved profile reference");
  });

  test("returns string unchanged when no references", () => {
    const raw = "no references here";
    expect(interpolateProfile(raw, {})).toBe(raw);
  });

  test("handles numeric values", () => {
    const result = interpolateProfile("port: ${profile.port}", { port: 3000 });
    expect(result).toBe("port: 3000");
  });

  test("handles boolean values", () => {
    const result = interpolateProfile("flag: ${profile.enabled}", { enabled: true });
    expect(result).toBe("flag: true");
  });

  test("deeply nested paths", () => {
    const result = interpolateProfile(
      "${profile.a.b.c.d}",
      { a: { b: { c: { d: "deep" } } } }
    );
    expect(result).toBe("deep");
  });
});

// ── deepMergeConfig ──────────────────────────────────────────────

describe("deepMergeConfig", () => {
  test("merges agent block", () => {
    const base: WorkflowConfig = {
      agent: {
        binary: "claude",
        max_turns: 10,
        permission_mode: "acceptEdits",
      },
    };
    const profile = {
      agent: {
        max_turns: 25,
        append_system_prompt: "Be concise",
      },
    };

    const result = deepMergeConfig(base, profile);
    expect(result.agent?.binary).toBe("claude"); // preserved from base
    expect(result.agent?.max_turns).toBe(25); // overridden by profile
    expect(result.agent?.permission_mode).toBe("acceptEdits"); // preserved from base
    expect(result.agent?.append_system_prompt).toBe("Be concise"); // added by profile
  });

  test("does not mutate base config", () => {
    const base: WorkflowConfig = { agent: { binary: "claude" } };
    const baseCopy = { ...base, agent: { ...base.agent } };
    deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(base.agent?.binary).toBe(baseCopy.agent?.binary);
  });

  test("handles profile with no agent block", () => {
    const base: WorkflowConfig = { agent: { binary: "claude" } };
    const result = deepMergeConfig(base, { other: "value" });
    expect(result.agent?.binary).toBe("claude");
  });

  test("handles base with no agent block", () => {
    const base: WorkflowConfig = {};
    const result = deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(result.agent?.binary).toBe("codex");
  });

  test("preserves non-agent config", () => {
    const base: WorkflowConfig = {
      tracker: { kind: "linear" },
      agent: { binary: "claude" },
    };
    const result = deepMergeConfig(base, { agent: { binary: "codex" } });
    expect(result.tracker?.kind).toBe("linear");
  });
});

// ── Shared profiles file ─────────────────────────────────────────

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach } from "bun:test";
import { expandWorkflowFile, loadProfileWorkflow } from "./profiles.js";

describe("shared profiles file", () => {
  let dir: string;

  const workflowBody = `
tracker:
  kind: linear
  api_key: \${profile.api_key}
  project_slug: \${profile.project_slug}
---
Working on \${profile.project_slug}
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "symphony-profiles-"));
    writeFileSync(
      join(dir, "projects.yaml"),
      `profiles:
  alpha:
    api_key: $KEY_A
    project_slug: alpha-slug
  beta:
    api_key: $KEY_B
    project_slug: beta-slug
    agent:
      max_turns: 7
`
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeWorkflow(frontmatter: string): string {
    const path = join(dir, "dev.md");
    writeFileSync(path, `---\n${frontmatter}${workflowBody}`);
    return path;
  }

  test("expands every profile when matrix is omitted", () => {
    const path = writeWorkflow("profiles: ./projects.yaml\n");
    expect(expandWorkflowFile(path).map((e) => e.virtualName)).toEqual(["dev:alpha", "dev:beta"]);
  });

  test("respects an explicit matrix subset", () => {
    const path = writeWorkflow("profiles: ./projects.yaml\nmatrix: [beta]\n");
    expect(expandWorkflowFile(path).map((e) => e.virtualName)).toEqual(["dev:beta"]);
  });

  test("throws when matrix names an unknown profile", () => {
    const path = writeWorkflow("profiles: ./projects.yaml\nmatrix: [gamma]\n");
    expect(() => expandWorkflowFile(path)).toThrow("Profile 'gamma' not found");
  });

  test("throws when the profiles file is missing", () => {
    const path = writeWorkflow("profiles: ./missing.yaml\n");
    expect(() => expandWorkflowFile(path)).toThrow("could not be read");
  });

  test("accepts a file with an unwrapped profile map", () => {
    writeFileSync(join(dir, "flat.yaml"), "solo:\n  api_key: x\n  project_slug: solo-slug\n");
    const path = writeWorkflow("profiles: ./flat.yaml\n");
    expect(expandWorkflowFile(path).map((e) => e.virtualName)).toEqual(["dev:solo"]);
  });

  test("loadProfileWorkflow interpolates values from the shared file", () => {
    const path = writeWorkflow("profiles: ./projects.yaml\n");
    const wf = loadProfileWorkflow(path, "beta");
    expect(wf.config.tracker?.project_slug).toBe("beta-slug");
    expect(wf.config.tracker?.api_key).toBe("$KEY_B");
    expect(wf.config.agent?.max_turns).toBe(7);
    expect(wf.config.profiles).toBeUndefined();
    expect(wf.prompt_template).toBe("Working on beta-slug");
  });

  test("inline profiles without matrix still produce a single workflow", () => {
    const path = writeWorkflow("profiles:\n  alpha:\n    api_key: a\n    project_slug: a\n");
    expect(expandWorkflowFile(path)).toEqual([{ path, virtualName: "dev" }]);
  });
});
