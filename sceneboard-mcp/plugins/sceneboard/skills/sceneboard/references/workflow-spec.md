# WorkflowSpec v1 binding schema and canonicalization contract

This is the implementation handoff for I-66. `workflow-spec.md` and
`WORKFLOW_SPEC_LIMITS_V1` must reproduce it without choosing new semantics. Every object is closed;
every listed field is required, and only fields explicitly typed `|null` accept null. Strings reject
C0 controls except tab/LF/CR and reject lone surrogates. Arrays reject duplicates where marked set.

## Primitive and envelope limits

| name                 | exact contract                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `Id`                 | string, `^[A-Za-z][A-Za-z0-9_-]{0,63}$`                                                               |
| `Token` / `StateKey` | string, 1..128 Unicode scalars, `^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`                                    |
| `Label`              | string, 1..120 scalars                                                                                |
| `Title`              | string, 1..200 scalars                                                                                |
| `LongText`           | string, 1..2,000 scalars                                                                              |
| `StepText`           | string, 1..1,000 scalars                                                                              |
| `Sha256`             | lowercase string, `^[0-9a-f]{64}$`                                                                    |
| JSON bytes           | 49,152 maximum before parse and after canonical serialization                                         |
| JSON structure       | depth 24; 4,096 total array items plus object members                                                 |
| document counts      | sources 1..32; subflows 0..8; total nodes 2..48; total edges 0..96; questions 0..128; warnings 0..256 |
| per-flow counts      | entries 1..8; exits 1..8; nodes 2..48; edges 0..96                                                    |
| per-node counts      | instructions 0..32; state inputs/outputs 0..32 each; tools/skills 0..16 each                          |
| other arrays         | source refs 0..16; state/edge/control refs 0..32; `retryOn` 0..8; question element refs 1..32         |

The smaller envelope/counts are deliberate: I-67 must fit one escaped canonical JSON copy, SVG
controls and a semantic fallback inside the existing 262,144-byte HTML and 360,448-byte combined
artifact source caps without adding a second runtime format.

## Closed object shapes

| type               | exact members and rules                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------- | ----------------------------------------------------- | -------------------------- | ---------------------------- |
| `WorkflowSpec`     | `schemaVersion:"1.0"`; `workflow:WorkflowIdentity`; `sources:Source[1..32]`; root `entryNodeIds:Id[1..8]`, `exitNodeIds:Id[1..8]`, `nodes:Node[2..48]`, `edges:Edge[0..96]`; `subflows:Subflow[0..8]`; `unresolvedQuestions:Question[0..128]`; `warnings:Warning[0..256]` |
| `WorkflowIdentity` | `id:Id`; `title:Title`; `summary:LongText                                                                                                                                                                                                                                 | null`; `evidence:Evidence`                                                                                                                                                    |
| `Source`           | `id:Id`; `kind:"langgraph"                                                                                                                                                                                                                                                | "markdown"                                                                                                                                                                    | "skill"                                                                    | "rules"                                                                                                                       | "code"                                                           | "prose"                     | "other"`; `label:Label`; `digest:Sha256               | null`                      |
| `Subflow`          | `id:Id`; `title:Title`; `entryNodeIds:Id[1..8]`; `exitNodeIds:Id[1..8]`; `nodes:Node[2..48]`; `edges:Edge[0..96]`; `evidence:Evidence`                                                                                                                                    |
| `Node`             | `id:Id`; `kind:NodeKind`; `label:Label`; `purpose:LongText                                                                                                                                                                                                                | null`; `instructions:StepText[0..32]`; `stateInputs:StateItem[0..32]`; `stateOutputs:StateItem[0..32]`; `tools:Token[0..16]`; `skills:Token[0..16]`; `retryPolicy:RetryPolicy | null`; `errorPolicy:ErrorPolicy                                            | null`; `subflowId:Id                                                                                                          | null`; `control:ParallelControl                                  | JoinControl                 | HumanControl                                          | null`; `evidence:Evidence` |
| `StateItem`        | `key:StateKey`; `type:"string"                                                                                                                                                                                                                                            | "number"                                                                                                                                                                      | "boolean"                                                                  | "object"                                                                                                                      | "array"                                                          | "null"                      | "unknown"`; `required:boolean`; `description:LongText | null`                      |
| `RetryPolicy`      | `maxAttempts:integer 1..10`; `backoff:"none"                                                                                                                                                                                                                              | "fixed"                                                                                                                                                                       | "linear"                                                                   | "exponential"`; `initialDelayMs:integer 0..300000`; `maxDelayMs:integer 0..300000`and`>= initialDelayMs`; `retryOn:("timeout" | "rate_limit"                                                     | "transient"                 | "validation"                                          | "tool_error"               | "unknown")[0..8]` unique set |
| `ErrorPolicy`      | `onExhaustedEdgeId:Id                                                                                                                                                                                                                                                     | null`; `emitsStateKeys:StateKey[0..32]` unique set                                                                                                                            |
| `ParallelControl`  | `mode:"all"                                                                                                                                                                                                                                                               | "any"`; `branchEdgeIds:Id[2..32]` unique set                                                                                                                                  |
| `JoinControl`      | `mode:"all"                                                                                                                                                                                                                                                               | "any"`; `incomingEdgeIds:Id[2..32]` unique set                                                                                                                                |
| `HumanControl`     | `interaction:"info"                                                                                                                                                                                                                                                       | "choice"                                                                                                                                                                      | "form"                                                                     | "confirmation"`; `blocking:boolean`                                                                                           |
| `Edge`             | `id:Id`; `kind:EdgeKind`; `fromNodeId:Id`; `toNodeId:Id`; `label:Label                                                                                                                                                                                                    | null`; `condition:Condition                                                                                                                                                   | null`; `priority:integer 0..1000                                           | null`; `stateKeys:StateKey[0..32]`unique set;`evidence:Evidence`                                                              |
| `Condition`        | `text:LongText`; `language:"natural"                                                                                                                                                                                                                                      | "cel"                                                                                                                                                                         | "javascript"                                                               | "python"                                                                                                                      | "other"                                                          | "unknown"`; inert text only |
| `Evidence`         | `basis:"explicit"                                                                                                                                                                                                                                                         | "inferred"                                                                                                                                                                    | "unknown"`; `confidence:finite number 0..1`; `sourceRefs:SourceRef[0..16]` |
| `SourceRef`        | `sourceId:Id`; `startLine:integer 1..10000000                                                                                                                                                                                                                             | null`; `endLine:integer 1..10000000                                                                                                                                           | null`; `locator:LongText                                                   | null`; line values are both null or both integers with `endLine>=startLine`                                                   |
| `ElementRef`       | `kind:"node"                                                                                                                                                                                                                                                              | "edge"                                                                                                                                                                        | "subflow"`; `id:Id`                                                        |
| `Question`         | `id:Id`; `prompt:LongText`; `relatedElements:ElementRef[1..32]` unique by `(kind,id)`; `evidence:Evidence`                                                                                                                                                                |
| `Warning`          | `id:Id`; `code:WarningCode`; `elementType:"workflow"                                                                                                                                                                                                                      | "node"                                                                                                                                                                        | "edge"                                                                     | "subflow"`; `elementId:Id                                                                                                     | null`(null iff workflow);`message:LongText`; `evidence:Evidence` |

`NodeKind` is exactly `start|action|decision|parallel|join|human|subflow|end` and `EdgeKind` exactly
`normal|conditional|parallel|join|retry|fallback|human`.

## Namespaces, references and kind matrix

- Node IDs are globally unique across root and subflows. Edge IDs are globally unique likewise.
  Source, subflow, question and warning IDs each have separate global namespaces. Canonicalization
  never derives, repairs or changes any ID.
- Edges stay within their owning flow. Entry IDs resolve to `start`, exit IDs to `end`; every start
  is an entry and every end an exit. No edge may enter start or leave end.
- `normal`: from `start|action|join|human|subflow` to any non-start node. `conditional`: from
  `decision` to any non-start. `parallel`: from `parallel` to any non-start and listed by that
  node's `branchEdgeIds`. `join`: from any non-end node to `join` and listed by its
  `incomingEdgeIds`. `retry`: from `action|human|subflow` to `action|human|subflow`. `fallback`:
  from `action|decision|human|subflow` to any non-start. `human`: exactly one endpoint is `human`.
- `parallel`/`join`/`human` nodes require their matching control object; all other kinds require
  `control:null`. Only `action|human|subflow` permit retry/error policies. Only subflow nodes carry
  `subflowId`; every reference resolves and the subflow-call graph is acyclic.
- A conditional edge requires non-null condition, except `evidence.basis:"unknown"` permits null and
  requires `UNKNOWN_CONDITION`. Every other edge requires `condition:null`. `onExhaustedEdgeId`,
  control edge IDs, state keys, source refs and element refs must resolve in their declared scope.

## Reject versus warning

Validation rejects with exactly
`INVALID_JSON|INVALID_UTF8|DUPLICATE_MEMBER|UNKNOWN_KEY|FORBIDDEN_KEY|INVALID_TYPE|INVALID_VALUE|
LIMIT_EXCEEDED|DUPLICATE_ID|DANGLING_REFERENCE|CROSS_FLOW_REFERENCE|INVALID_KIND_COMBINATION|
RECURSIVE_SUBFLOW`. Unknown keys and `__proto__|prototype|constructor` are rejected at every depth.

Valid graphs retain warnings with exactly
`UNREACHABLE_NODE|NON_RETRY_CYCLE|UNKNOWN_CONDITION|DECISION_ROUTE_MISSING|
PARALLEL_JOIN_MISMATCH|UNCERTAIN_ROUTE`. Dangling references and declared control/ref mismatches
reject; reachability, a non-retry cycle, absent decision routes, uncertain conditions and a
topologically unmatched but internally valid parallel/join structure warn. Analysis appends no
message invented from source; it emits deterministic code/default message/evidence records.

## Canonical order

- Object keys: ascending Unicode-scalar key order. No Unicode or numeric normalization. Finite JSON
  numbers use the shared canonical JSON serializer.
- Sort by `id` ascending: sources, root/subflow nodes, root/subflow edges and subflows. Sort unique
  scalar ID/token sets ascending: entry/exit IDs, tools, skills, retryOn, emitsStateKeys,
  branch/incoming edge IDs and edge stateKeys. Sort state items by `key`.
- Sort `sourceRefs` by `(sourceId,startLine null-first,endLine null-first,locator null-first)` and
  `relatedElements` by `(kind,id)`. Preserve `instructions`, `unresolvedQuestions` and `warnings` in
  authored/analyzer order. A second canonicalization is byte-identical.

## CLI I/O and diagnostic contract

Commands are exactly `validate <input>` and `canonicalize <input> <output>`; no stdin/stdout aliases.
Success emits one JSON record `{status:"PASS"}` and exits 0. Validation errors exit 1 and emit one
`{status:"FAIL",code,path}` record using the validation code and logical JSON pointer. Usage/I/O
errors exit 2, use path `"/input"`, `"/output"`, or `""`, and use exactly:

`USAGE_ERROR|INPUT_NOT_FOUND|INPUT_SYMLINK|INPUT_NOT_REGULAR|INPUT_READ_FAILED|OUTPUT_ALIAS_INPUT|
OUTPUT_PARENT_INVALID|OUTPUT_SYMLINK|OUTPUT_NOT_REGULAR|OUTPUT_CHANGED|OUTPUT_TEMP_CREATE_FAILED|
OUTPUT_WRITE_FAILED|OUTPUT_SYNC_FAILED|OUTPUT_RENAME_FAILED`.

| exit-2 code                 | exact path  | exact trigger                                                 |
| --------------------------- | ----------- | ------------------------------------------------------------- |
| `USAGE_ERROR`               | `""`        | command/arity is not one of the two exact forms               |
| `INPUT_NOT_FOUND`           | `"/input"`  | input path does not exist                                     |
| `INPUT_SYMLINK`             | `"/input"`  | input final entry is a symlink/no-follow rejection            |
| `INPUT_NOT_REGULAR`         | `"/input"`  | opened input is not a regular file                            |
| `INPUT_READ_FAILED`         | `"/input"`  | safe open/stat/read fails for any other OS reason             |
| `OUTPUT_ALIAS_INPUT`        | `"/output"` | output lexical identity or existing device/inode equals input |
| `OUTPUT_PARENT_INVALID`     | `"/output"` | resolved parent is absent, symlinked, or not a directory      |
| `OUTPUT_SYMLINK`            | `"/output"` | output final entry is a symlink                               |
| `OUTPUT_NOT_REGULAR`        | `"/output"` | existing output is not a regular file                         |
| `OUTPUT_CHANGED`            | `"/output"` | pre-rename existence/device/inode differs from recorded state |
| `OUTPUT_TEMP_CREATE_FAILED` | `"/output"` | adjacent exclusive no-follow temp creation fails              |
| `OUTPUT_WRITE_FAILED`       | `"/output"` | temp write or close fails before commit                       |
| `OUTPUT_SYNC_FAILED`        | `"/output"` | temp fsync fails pre-commit or parent fsync fails post-commit |
| `OUTPUT_RENAME_FAILED`      | `"/output"` | atomic temp-to-output rename fails                            |

The record never includes input values, source text, absolute paths, OS messages or stack traces.
Input is opened no-follow, stat-verified regular, bounded before parse, decoded fatally and scanned
for duplicate members. Canonicalize resolves/stats the parent directory, rejects an input/output
lexical or device/inode alias, lstat-checks the output as absent or regular non-symlink, records its
device/inode, creates an adjacent mode-0600 `O_EXCL|O_NOFOLLOW` temp, writes/fsyncs/closes it, and
rechecks the output is still absent or the same device/inode before atomic rename. Rename is the
commit point and never follows the final entry. Every pre-commit failure unlinks temp and preserves
the prior target; a post-rename parent-fsync failure returns `OUTPUT_SYNC_FAILED` with the committed
new file intact. Each table row fixture asserts the exact code/path pair; every alias/race case and
max/max+1 boundary has a fixture.
