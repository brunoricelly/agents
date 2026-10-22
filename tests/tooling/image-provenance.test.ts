import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const DOCKERFILE = readFileSync("Dockerfile", "utf8");
const WORKFLOW_PATH = ".github/workflows/publish_github_package.yml";
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type Workflow = {
  jobs: Record<string, { steps?: Step[] }>;
};

const workflow = Bun.YAML.parse(WORKFLOW) as Workflow;
const buildSteps = workflow.jobs.build?.steps ?? [];
const sourceCommitExpression = `\${{ env.SOURCE_COMMIT }}`;
const repositoryExpression = `\${{ github.repository }}`;

describe("runtime image source provenance", () => {
  test("the final stage validates and persists the source commit", () => {
    const runtime = DOCKERFILE.split("FROM base AS runtime\n")[1];

    expect(runtime).toBeDefined();
    expect(runtime).toContain("ARG SOURCE_COMMIT");
    expect(runtime).toContain(
      "LABEL org.opencontainers.image.revision=$SOURCE_COMMIT",
    );
    expect(runtime).toContain(
      `test "$(printf '%s' "$SOURCE_COMMIT" | wc -c)" -eq 40`,
    );
    expect(runtime).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(runtime).toContain(`printf '%s' "$SOURCE_COMMIT" > /app/.git_sha`);
  });

  test("provenance is declared only on the final runtime stage", () => {
    expect(DOCKERFILE.match(/^ARG SOURCE_COMMIT$/gm)).toHaveLength(1);
    expect(
      DOCKERFILE.match(/^LABEL org\.opencontainers\.image\.revision=/gm),
    ).toHaveLength(1);
  });
});

describe("release workflow source provenance", () => {
  test("derives and validates the exact checked-out commit", () => {
    const checkoutIndex = buildSteps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const sourceIndex = buildSteps.findIndex(
      (step) => step.name === "Resolve source commit",
    );
    const sourceStep = buildSteps[sourceIndex];

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeGreaterThan(checkoutIndex);
    expect(sourceStep?.run).toContain("git rev-parse HEAD");
    expect(sourceStep?.run).toContain("^[0-9a-f]{40}$");
    expect(sourceStep?.run).toContain(
      'echo "SOURCE_COMMIT=$source_commit" >> "$GITHUB_ENV"',
    );
  });

  test("passes identical provenance to every image builder", () => {
    const imageBuilds = buildSteps.filter((step) =>
      step.uses?.includes("build-push-action@"),
    );

    expect(imageBuilds).toHaveLength(2);
    for (const step of imageBuilds) {
      expect(step.with?.["build-args"]).toContain(
        `SOURCE_COMMIT=${sourceCommitExpression}`,
      );
      expect(step.with?.labels).toContain(
        `org.opencontainers.image.source=https://github.com/${repositoryExpression}`,
      );
      expect(step.with?.labels).toContain(
        `org.opencontainers.image.revision=${sourceCommitExpression}`,
      );
    }
  });
});
