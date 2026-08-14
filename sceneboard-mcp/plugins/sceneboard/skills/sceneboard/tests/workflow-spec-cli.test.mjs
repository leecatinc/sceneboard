import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chown,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  WorkflowSpecError,
  analyzeWorkflowSpec,
  canonicalizeWorkflowSpec,
  parseWorkflowSpec,
  validateWorkflowSpec,
} from "../scripts/workflow-spec-core.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = resolve(root, "assets/workflow-spec-examples");
const cli = resolve(root, "scripts/workflow-spec.mjs");
const examples = [
  "linear-review.json",
  "conditional-hitl.json",
  "parallel-retry.json",
];
const readExample = async (name = examples[0]) =>
  JSON.parse(await readFile(resolve(examplesRoot, name), "utf8"));
const assertWorkflowError = (value, code, path) =>
  assert.throws(
    () => validateWorkflowSpec(value),
    (error) =>
      error instanceof WorkflowSpecError &&
      error.code === code &&
      error.path === path,
  );

test("shipped examples validate and canonicalize idempotently", async () => {
  for (const name of examples) {
    const value = await readExample(name);
    validateWorkflowSpec(value);
    const canonical = canonicalizeWorkflowSpec(value);
    assert.equal(
      canonicalizeWorkflowSpec(parseWorkflowSpec(canonical)),
      canonical,
    );
    assert.ok(Buffer.byteLength(canonical) <= 49_152);
  }
});

test("legacy v1 explicit evidence may retain an empty source reference set", async () => {
  const value = await readExample("conditional-hitl.json");
  const nodeId = value.nodes[0].id;
  value.nodes[0].evidence.sourceRefs = [];
  validateWorkflowSpec(value);
  assert.deepEqual(
    JSON.parse(canonicalizeWorkflowSpec(value)).nodes.find(({ id }) => id === nodeId)
      .evidence.sourceRefs,
    [],
  );
});

test("canonicalization sorts identity sets and preserves question and warning order", async () => {
  const value = await readExample("conditional-hitl.json");
  value.sources.push({
    id: "source_aaa",
    kind: "other",
    label: "Additional source",
    digest: null,
  });
  value.sources.reverse();
  value.unresolvedQuestions.push({
    id: "question_second",
    prompt: "Who approves?",
    relatedElements: [{ kind: "node", id: "approval_human" }],
    evidence: { basis: "unknown", confidence: 0, sourceRefs: [] },
  });
  const canonical = JSON.parse(canonicalizeWorkflowSpec(value));
  assert.deepEqual(
    canonical.sources.map(({ id }) => id),
    ["source_aaa", "source_approval"],
  );
  assert.deepEqual(
    canonical.unresolvedQuestions.map(({ id }) => id),
    ["question_condition", "question_second"],
  );
});

test("canonicalization orders nullable source positions numerically", async () => {
  const value = await readExample();
  value.nodes[1].evidence.sourceRefs = [
    { sourceId: "source_review", startLine: 10, endLine: 10, locator: null },
    {
      sourceId: "source_review",
      startLine: null,
      endLine: null,
      locator: "overview",
    },
    { sourceId: "source_review", startLine: 2, endLine: 2, locator: null },
  ];
  const canonical = JSON.parse(canonicalizeWorkflowSpec(value));
  assert.deepEqual(
    canonical.nodes
      .find(({ id }) => id === "node_review")
      .evidence.sourceRefs.map(({ startLine }) => startLine),
    [null, 2, 10],
  );
});

test("stable edge IDs distinguish routes and cross-flow references reject", async () => {
  const value = await readExample();
  value.edges.push({ ...value.edges[0], id: "edge_start_review_alternate" });
  assert.equal(validateWorkflowSpec(value).edges.length, 3);
  value.edges.at(-1).toNodeId = "node_missing";
  assert.throws(
    () => validateWorkflowSpec(value),
    (error) =>
      error instanceof WorkflowSpecError &&
      error.code === "CROSS_FLOW_REFERENCE",
  );
});

test("strict parser rejects duplicate members, forbidden keys and oversized input", () => {
  for (const [input, code, path] of [
    [
      '{"schemaVersion":"1.0","schemaVersion":"1.0"}',
      "DUPLICATE_MEMBER",
      "/schemaVersion",
    ],
    ['{"__proto__":{}}', "FORBIDDEN_KEY", "/__proto__"],
    ['{"workflow":{"id":"a","id":"b"}}', "DUPLICATE_MEMBER", "/workflow/id"],
    [
      '{"items":[{"a/b":{"~key":1,"~key":2}}]}',
      "DUPLICATE_MEMBER",
      "/items/0/a~1b/~0key",
    ],
    ['{"items":[{"constructor":{}}]}', "FORBIDDEN_KEY", "/items/0/constructor"],
    [" ".repeat(49_153), "LIMIT_EXCEEDED", ""],
  ])
    assert.throws(
      () => parseWorkflowSpec(input),
      (error) =>
        error instanceof WorkflowSpecError &&
        error.code === code &&
        error.path === path &&
        error.message === code,
    );
});

test("edge state keys and unknown conditions resolve through declared records", async () => {
  const invalidState = await readExample();
  invalidState.edges[0].stateKeys = ["missing_state"];
  assert.throws(
    () => validateWorkflowSpec(invalidState),
    (error) =>
      error instanceof WorkflowSpecError && error.code === "DANGLING_REFERENCE",
  );

  const unknownCondition = await readExample("conditional-hitl.json");
  const edge = unknownCondition.edges.find(
    ({ kind }) => kind === "conditional",
  );
  edge.condition = null;
  edge.evidence = { basis: "unknown", confidence: 0, sourceRefs: [] };
  assert.throws(
    () => validateWorkflowSpec(unknownCondition),
    (error) =>
      error instanceof WorkflowSpecError && error.code === "DANGLING_REFERENCE",
  );
  unknownCondition.warnings.push({
    id: "warning_unknown_condition",
    code: "UNKNOWN_CONDITION",
    elementType: "edge",
    elementId: edge.id,
    message: "The route condition is unknown.",
    evidence: { basis: "unknown", confidence: 0, sourceRefs: [] },
  });
  assert.equal(validateWorkflowSpec(unknownCondition), unknownCondition);
});

test("analysis reports unreachable nodes without mutating the contract", async () => {
  const value = await readExample();
  value.nodes.push({
    ...value.nodes[1],
    id: "node_unreachable",
    label: "Unreachable",
    evidence: { basis: "unknown", confidence: 0, sourceRefs: [] },
  });
  assert.deepEqual(analyzeWorkflowSpec(value).warnings, [
    {
      id: "analysis_warning_001",
      code: "UNREACHABLE_NODE",
      elementType: "node",
      elementId: "node_unreachable",
      message: "The node is not reachable from a declared entry node.",
      evidence: { basis: "unknown", confidence: 0, sourceRefs: [] },
    },
  ]);
});

test("analysis emits every deterministic WorkflowSpec warning class", async () => {
  const decision = await readExample("conditional-hitl.json");
  decision.edges = decision.edges.filter(
    ({ id }) => id !== "approval_edge_direct",
  );
  const decisionWarning = analyzeWorkflowSpec(decision).warnings.find(
    ({ code }) => code === "DECISION_ROUTE_MISSING",
  );
  assert.equal(decisionWarning.elementId, "approval_route");

  const uncertain = await readExample("conditional-hitl.json");
  uncertain.edges[1].condition.language = "unknown";
  uncertain.edges[1].evidence = {
    basis: "unknown",
    confidence: 0,
    sourceRefs: [],
  };
  assert.equal(
    analyzeWorkflowSpec(uncertain).warnings.some(
      ({ code }) => code === "UNCERTAIN_ROUTE",
    ),
    true,
  );

  const unknown = await readExample("conditional-hitl.json");
  unknown.edges[1].condition = null;
  unknown.edges[1].evidence = {
    basis: "unknown",
    confidence: 0,
    sourceRefs: [],
  };
  unknown.warnings.push({
    id: "warning_unknown_analysis",
    code: "UNKNOWN_CONDITION",
    elementType: "edge",
    elementId: unknown.edges[1].id,
    message: "The route condition is unknown.",
    evidence: { basis: "unknown", confidence: 0, sourceRefs: [] },
  });
  assert.equal(
    analyzeWorkflowSpec(unknown).warnings.some(
      ({ code }) => code === "UNKNOWN_CONDITION",
    ),
    true,
  );

  const cycle = await readExample();
  cycle.edges.push({
    ...structuredClone(cycle.edges[1]),
    id: "edge_review_cycle",
    kind: "fallback",
    fromNodeId: "node_review",
    toNodeId: "node_review",
  });
  assert.equal(
    analyzeWorkflowSpec(cycle).warnings.some(
      ({ code }) => code === "NON_RETRY_CYCLE",
    ),
    true,
  );

  const parallel = await readExample("parallel-retry.json");
  parallel.nodes.find(({ kind }) => kind === "join").control.mode = "any";
  assert.equal(
    analyzeWorkflowSpec(parallel).warnings.some(
      ({ code }) => code === "PARALLEL_JOIN_MISMATCH",
    ),
    true,
  );
});

test("subflow nodes can reference only the dedicated subflow namespace", async () => {
  const value = await readExample("parallel-retry.json");
  value.nodes.find(({ kind }) => kind === "subflow").subflowId =
    value.workflow.id;
  assertWorkflowError(value, "DANGLING_REFERENCE", "/nodes/3/subflowId");
});

test("semantic diagnostics use resolving index-based JSON pointers", async () => {
  const duplicate = await readExample("parallel-retry.json");
  const duplicateNode = structuredClone(duplicate.nodes[2]);
  duplicate.subflows[0].nodes.push(duplicateNode);
  duplicate.subflows[0].edges[0].toNodeId = duplicateNode.id;
  duplicate.subflows[0].edges.push({
    ...structuredClone(duplicate.subflows[0].edges[0]),
    id: "review_duplicate_end",
    fromNodeId: duplicateNode.id,
    toNodeId: "review_end",
  });
  assertWorkflowError(duplicate, "DUPLICATE_ID", "/subflows/0/nodes/2/id");

  const crossKindDuplicate = await readExample();
  crossKindDuplicate.edges[0].id = crossKindDuplicate.nodes[0].id;
  assertWorkflowError(crossKindDuplicate, "DUPLICATE_ID", "/edges/0/id");

  const flowDuplicate = await readExample("parallel-retry.json");
  flowDuplicate.subflows[0].id = flowDuplicate.workflow.id;
  assertWorkflowError(flowDuplicate, "DUPLICATE_ID", "/subflows/0/id");

  const control = await readExample("parallel-retry.json");
  control.nodes[1].control.branchEdgeIds[0] = "missing_edge";
  assertWorkflowError(
    control,
    "DANGLING_REFERENCE",
    "/nodes/1/control/branchEdgeIds",
  );

  const errorPolicy = await readExample("parallel-retry.json");
  errorPolicy.nodes[2].errorPolicy = {
    onExhaustedEdgeId: "missing_edge",
    emitsStateKeys: [],
  };
  assertWorkflowError(
    errorPolicy,
    "DANGLING_REFERENCE",
    "/nodes/2/errorPolicy/onExhaustedEdgeId",
  );

  const recursive = await readExample("parallel-retry.json");
  const recursiveNode = structuredClone(recursive.nodes[3]);
  recursiveNode.id = "review_recursive";
  recursive.subflows[0].nodes.push(recursiveNode);
  recursive.subflows[0].edges[0].toNodeId = recursiveNode.id;
  recursive.subflows[0].edges.push({
    ...structuredClone(recursive.subflows[0].edges[0]),
    id: "review_recursive_end",
    fromNodeId: recursiveNode.id,
    toNodeId: "review_end",
  });
  assertWorkflowError(
    recursive,
    "RECURSIVE_SUBFLOW",
    "/subflows/0/nodes/2/subflowId",
  );
});

test("file-only CLI emits exact success and safe failure records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sceneboard-workflow-spec-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = resolve(directory, "input.json");
  const output = resolve(directory, "output.json");
  const link = resolve(directory, "link.json");
  await writeFile(input, await readFile(resolve(examplesRoot, examples[0])));
  await symlink(input, link);
  const validation = await execFileAsync(
    process.execPath,
    [cli, "validate", input],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(validation.stdout), { status: "PASS" });
  const canonicalized = await execFileAsync(
    process.execPath,
    [cli, "canonicalize", input, output],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(canonicalized.stdout), { status: "PASS" });
  assert.equal(
    await readFile(output, "utf8"),
    canonicalizeWorkflowSpec(await readExample()),
  );
  for (const [arguments_, code, path, exitCode] of [
    [["validate", link], "INPUT_SYMLINK", "/input", 2],
    [["canonicalize", input, input], "OUTPUT_ALIAS_INPUT", "/output", 2],
    [["unknown"], "USAGE_ERROR", "", 2],
  ])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, ...arguments_]),
      (error) => {
        assert.equal(error.code, exitCode);
        assert.deepEqual(JSON.parse(error.stderr), {
          status: "FAIL",
          code,
          path,
        });
        return true;
      },
    );
});

test("canonicalize preserves existing metadata and lets new files inherit defaults", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sceneboard-workflow-mode-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = resolve(directory, "input.json");
  const existing = resolve(directory, "existing.json");
  const created = resolve(directory, "created.json");
  const control = resolve(directory, "control.json");
  await writeFile(input, await readFile(resolve(examplesRoot, examples[0])));
  await writeFile(existing, "previous");
  await chmod(existing, 0o600);
  if (process.platform !== "win32" && process.getuid !== undefined) {
    const parentGroup = (await stat(directory)).gid;
    const alternateGroup = process
      .getgroups()
      .find((group) => group !== parentGroup);
    if (alternateGroup !== undefined)
      await chown(existing, process.getuid(), alternateGroup);
  }
  await chmod(existing, 0o4600);
  const previousIdentity = await stat(existing);
  await execFileAsync(process.execPath, [cli, "canonicalize", input, existing]);
  await execFileAsync(process.execPath, [cli, "canonicalize", input, created]);
  await writeFile(control, "control");
  const currentIdentity = await stat(existing);
  assert.equal(currentIdentity.mode & 0o777, 0o600);
  assert.equal(currentIdentity.uid, previousIdentity.uid);
  assert.equal(currentIdentity.gid, previousIdentity.gid);
  assert.notEqual(currentIdentity.ino, previousIdentity.ino);
  assert.equal(
    (await stat(created)).mode & 0o777,
    (await stat(control)).mode & 0o777,
  );
});

test("canonicalize fails closed when an existing mode could hide named ACL readers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sceneboard-workflow-acl-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = resolve(directory, "input.json");
  const output = resolve(directory, "output.json");
  await writeFile(input, await readFile(resolve(examplesRoot, examples[0])));
  await writeFile(output, "previous");
  await chmod(output, 0o640);
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "canonicalize", input, output]),
    (error) => {
      assert.equal(error.code, 2);
      assert.deepEqual(JSON.parse(error.stderr), {
        status: "FAIL",
        code: "OUTPUT_ACL_UNSAFE",
        path: "/output",
      });
      return true;
    },
  );
  assert.equal(await readFile(output, "utf8"), "previous");
});

test("production CLI remains inside the file-only no-child-process boundary", async () => {
  const source = await readFile(cli, "utf8");
  assert.match(source, /randomBytes\(16\)/u);
  assert.doesNotMatch(source, /Date\.now\(\)/u);
  assert.doesNotMatch(
    source,
    /node:child_process|\b(?:exec|execFile|spawn|fork)(?:Sync)?\b/u,
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function)\b/u,
  );
  assert.doesNotMatch(source, /\bimport\s*\(/u);
});

test("CLI rejects malformed UTF-8 and max-plus-one bytes with validation exit 1", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sceneboard-workflow-bytes-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const malformed = resolve(directory, "malformed.json");
  const oversized = resolve(directory, "oversized.json");
  const substantiallyOversized = resolve(
    directory,
    "substantially-oversized.json",
  );
  await writeFile(malformed, Buffer.from([0xc3, 0x28]));
  await writeFile(oversized, Buffer.alloc(49_153, 0x20));
  await writeFile(substantiallyOversized, Buffer.alloc(98_304, 0x20));
  for (const [path, code] of [
    [malformed, "INVALID_UTF8"],
    [oversized, "LIMIT_EXCEEDED"],
    [substantiallyOversized, "LIMIT_EXCEEDED"],
  ])
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "validate", path]),
      (error) => {
        assert.equal(error.code, 1);
        assert.deepEqual(JSON.parse(error.stderr), {
          status: "FAIL",
          code,
          path: "",
        });
        return true;
      },
    );
});
