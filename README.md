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
- MySQL 8.0.16 through 8.0.x
- Redis

Install from the repository root and run the deterministic checks:

```bash
npm ci
npm run check
```

Copy only the required `.env.example` files to local ignored `.env` files.
Never commit credentials, generated recordings, screenshots containing personal
data, or runtime state.

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
