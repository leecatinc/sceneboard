# SceneBoard sandboxed artifact contract

Use an artifact only when trusted nodes cannot preserve the intended visualization. Artifacts execute on a distinct runtime origin in an `allow-scripts` sandbox, never in the authenticated app origin.

## Exact MCP operations

- `board_artifact_put` accepts all eight exact source fields: `boardId`, `expectedRevisionId`, `idempotencyKey`, explicit nullable `artifactId`, `html`, explicit nullable `css`, explicit nullable `javascript`, and sorted unique `requestedCapabilities`.
- The server normalizes that bounded source into immutable `index.html`, optional `styles.css`, optional `main.js`, their SHA-256/length/media types, and one manifest/version. Same semantic key/actor produces stable IDs.
- `board_artifact_get` reads exact `{artifactId,versionId}` metadata/runtime. It returns no raw secret-bearing URL or resource substitution.
- `board_artifact_stop` stops the exact runtime version. It does not delete the immutable version or remove a `content.artifact` scene node; remove the scene reference with a separate scene transform.

There is no `board_artifact_remove`.

## Isolation and bridge

- Parent/render origins, CSP, iframe sandbox, COOP/COEP/CORP/referrer/cache headers, package integrity, bridge nonce/correlation, payload bounds, event rates, CPU/memory liveness, and teardown are runtime owned.
- Parent/artifact communication uses only the versioned validated bridge. Unknown origin/source/nonce/type/sequence/payload fails closed.
- Model-authored markup never reaches parent `dangerouslySetInnerHTML`.
- Production HTTPS parents require a distinct, reachable HTTPS runtime origin with valid DNS/TLS. A build that points the public app at `http://127.0.0.2:3412` is local-certification topology only and must not be reported as a browser-rendered production artifact.
- Browser QA must distinguish immutable publication (`board_artifact_put`/`get` reports `ready`) from bridge activation (`.artifact-host.artifact-active`). A safe fallback or failed host means persistence succeeded but rendering did not.

## Capabilities and visuals

Requested capabilities are exactly `clipboard.write`, `download`, `fullscreen`, and `network.fetch`. Input only requests; current server/user policy approves or denies. Only `board_artifact_put` may surface `CAPABILITY_DENIED` for a known-but-ungranted request.

The closed `workflow-graph` template is the only shipped template that can request
`clipboard.write`. It may use a host-copy variant only when a fresh authenticated
`board_capabilities_get` result currently allows that capability. Every variant places one
`JSON export` control after `Selected` and opens the complete canonical WorkflowSpec in a read-only
modal. The host-copy variant adds one `Copy JSON` action inside that modal. The host accepts one
same-ID, transiently activated request, validates exact text and returns only byte length or a closed
error; denial or timeout leaves the modal open and selects the canonical source for manual copy.
The manual variant requests no capability and exposes the same JSON modal with a `Select all` action,
but no host-copy action. Public-share and export hosts omit the allow-list and stay denied, so they
remain on this manual path.

Network uses the bounded broker and remains default denied; provider credentials stay server-side. Diagrams use the vendored content-hashed Mermaid asset or authored SVG/Canvas, never external CDN code. Raster `data:` URIs must be consumed by runtime JavaScript through Canvas/dynamic image creation; static `<img src="data:…">` and CSS data URLs are rejected.

## Immutable history

Every history reference pins an immutable artifact/version pair. New source creates a new version; stop preserves evidence. If retained bytes are unavailable, show the exact safe placeholder/metadata and never substitute another version.
