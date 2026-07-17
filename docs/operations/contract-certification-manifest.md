# SceneBoard contract certification manifest

`test/certification/contract-input-inventory.v1.json` is the closed literal input list. `test/certification/contract-manifest.v1.json` stores one owner and observed fingerprint for each of its 375 alias-independent global keys.

The global key is `(canonicalPath, exportName, exportKind, selectorSha256, canonicalization)`. Labels such as inventory/resource ID do not define identity. Paths are repository-relative and include the eight exact read-only downloadable `skills/sceanboard` skill files. Symlinks, globs, discovery, owner inference, whole-file/projection overlap, selector overlap, aliases, and a second topology file fail closed.

The manifest freezes:

- nine represented D1-D9 owners and 375 results;
- local app/API/runtime origins `127.0.0.1:3410`, `127.0.0.1:3411`, `127.0.0.2:3412`, plus MCP stdio;
- 15 migration entries and 18 SQL assets;
- exact 3/15/21 MCP cuts and terminal tool order;
- D3's nine paths/17 selectors and four browser-adapter publishers/20 disjoint methods;
- 181 D1 fixtures, four schema projections, eight downloadable-skill contract files, and 418 public-registry dependencies.

The committed manifest is canonical JSON and contains `inventorySha256`, but never `manifestSha256`, source commit, attempt/lane identity, or runtime evidence hashes. `npm run verify:contracts` recomputes all results read-only and never rewrites the inventory or manifest.

The runtime release envelope owns the manifest SHA-256 and execution identity. Watched-input drift aborts the entire attempt; partial recomputation is forbidden.
