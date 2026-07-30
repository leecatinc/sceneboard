# SceneBoard

SceneBoard is an open visual workspace for Codex. It gives AI coding agents a
persistent whiteboard where plans, decisions, human-in-the-loop requests,
diagrams, drawings, interactive prototypes, and sandboxed 3D artifacts can be
presented outside a dense terminal transcript.

The core product goal is simple: an AI should explain complex work in human
language on one self-contained screen. References such as “D1” or “D2” should
be expanded into the relevant constraints and consequences so a person can
understand the decision without opening a chain of supporting documents.

SceneBoard was originally created by **LeeCat** and is licensed under
[Apache-2.0](LICENSE).

## Repository layout

| Path                         | Responsibility                                               |
| ---------------------------- | ------------------------------------------------------------ |
| `sceneboard-fe/`             | Next.js web application and owner approval interface         |
| `sceneboard-be/`             | NestJS API, authentication, pairing, board history, and HITL |
| `sceneboard-mcp/`            | SceneBoard MCP server and Codex plugin                       |
| `packages/board-schema/`     | Shared closed protocol schemas                               |
| `packages/board-sdk/`        | Shared browser and server protocol clients                   |
| `packages/board-ui/`         | Board rendering components                                   |
| `packages/artifact-runtime/` | Isolated HTML, Canvas, SVG, and Three.js runtime             |
| `rules/`                     | Public engineering, security, Git, and QA rules              |

## Install the Codex plugin

After the public marketplace release, install SceneBoard from this repository:

```bash
codex plugin marketplace add leecatinc/sceneboard
codex plugin add sceneboard@sceneboard
```

Start a new Codex thread, create a one-time connection code at
[sceneboard.dev](https://sceneboard.dev), send the `SB-...` code to SceneBoard,
and approve only the requested boards and capabilities.

## Local development

Requirements:

- Node.js 22 or later
- npm 10.9.3
- MySQL 8.0.16 through 8.0.x (a database named `sceneboard`)
- Redis (key prefix `sceneboard:`)

### 1. Install and verify

```bash
npm ci
npm run check   # config audit → contracts → lint → typecheck → tests → build check
```

### 2. Configure environment

Copy each service's `.env.example` to a local, git-ignored `.env` and fill it in:

```bash
cp sceneboard-be/.env.example  sceneboard-be/.env
cp sceneboard-fe/.env.example  sceneboard-fe/.env
cp sceneboard-mcp/.env.example sceneboard-mcp/.env
cp packages/artifact-runtime/.env.example packages/artifact-runtime/.env
```

The backend validates its environment strictly and refuses to boot unless
`MYSQL_DATABASE=sceneboard` and `REDIS_KEY_PREFIX=sceneboard:`. The signing
secrets (the `*_KEY_B64` and `*_PEPPER_B64` entries in `sceneboard-be/.env.example`)
must each be high-entropy material of at least 32 bytes, in the exact encoding that
key documents — most are canonical unpadded base64url, while `BOARD_STREAM_KEY_B64`
is padded RFC 4648 base64. Services read configuration from the process
environment, so export the variables (or use a dotenv runner) before starting each
service — copying `.env.example` alone does not load them. Never commit
credentials, generated recordings, screenshots with personal data, or runtime state.
Account API-key issuance and bearer authentication remain disabled unless
`ACCOUNT_API_KEY_ISSUANCE_ENABLED=true` and `ACCOUNT_API_KEY_AUTH_ENABLED=true` are
set explicitly after migration certification.
When enabled, an account API key can use the existing board list, get, create, rename,
archive, capabilities, scene/document, and history HTTP contracts for boards currently
owned by its account. Each operation still requires its literal key scope; API keys do
not gain membership, share, media, artifact, HITL, physical-delete, or pairing-grant
administration, and the pairing flow remains available independently.
Document V3 writing likewise remains disabled until
`BOARD_DOCUMENT_V3_WRITE_ENABLED=true` is set after migration 026 certification; V3-capable
readers remain available while the writer flag is false.

Board document clients negotiate the checkpoint shape with
`documentSchemaVersion=1|2|3` on board GET, history, mutation/restore, capabilities,
and SSE routes. Version 3 adds the document-level `format` value
(`wide_16_9`, `standard_4_3`, `a4_portrait`, or `a4_landscape`). A V3 head requires
an explicit capable selector; selector 2 receives the deterministic V2 projection,
while selector 3 preserves the format-bearing V3 document. Browser format controls
emit a single V3 `document.replace` revision and remain separate from page fit,
zoom, pan, and presentation view state.

### 3. Prepare the database

```bash
npm run db:migrate:up --workspace sceneboard-be   # applies the checksummed migration ledger
```

### 4. Build and run

Run each long-lived service in its own terminal (the `start` commands block).

```bash
# Backend needs a compiled dist; the dev frontend compiles on demand.
npm run build --workspace sceneboard-be
npm run build:runtime --workspace @sceneboard/artifact-runtime

npm run start --workspace sceneboard-be     # NestJS API on :3411 (PORT-driven)
npm run dev   --workspace sceneboard-fe     # Next.js web on :3410
```

The sandboxed artifact runtime (`:3412`) runs on a **separate origin** and is
launched with regenerated auth-origin evidence via
`packages/artifact-runtime/deploy/launch-dev-runtime.sh` (run from the repository
root with its required environment exported). The hosted deployment — app, API, and
artifact runtime on distinct origins — is documented in the release runbook
maintained outside this repository.

## Engineering policy

AI agents and human contributors start at [AGENTS.md](AGENTS.md). The nearest
applicable `rules/RULES.md` wins for its subtree, with
[`rules/CRITICAL.md`](rules/CRITICAL.md) taking precedence over all detailed
rules. All public engineering artifacts, comments, logs, and Git metadata are
written in English; localization catalogs intentionally contain supported
product languages.

## Contributing

Contributions are welcome. Preserve the closed protocol boundaries, add a
failing regression test before behavior changes, run the focused checks and
`npm run check`, and keep LeeCat attribution in `NOTICE` as required by the
license.

Security vulnerabilities should not be posted with exploit details in a public
issue. Contact the project maintainers privately before disclosure.

## License

Copyright 2026 LeeCat. Licensed under the Apache License, Version 2.0. See
[LICENSE](LICENSE) and [NOTICE](NOTICE).
