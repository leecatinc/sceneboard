# SceneBoard scene and local transform contract

## D1 scene shape

SceneBoard v1 is one recursive node tree, not a blocks map:

```json
{
  "protocolVersion": 1,
  "type": "scene",
  "root": null
}
```

Every non-null node owns a stable `id` (`NodeId`). There is no `schemaVersion`, scene title/theme/metadata, layout leaf `blockId`, unbounded stack/group, diff/mermaid/checklist/timeline/log node, or executable HTML trusted node.

The closed 15-node catalog is:

- Layout: `layout.split`, `layout.grid`, `layout.tabs`, `layout.canvas`.
- Trusted content: `content.markdown`, `content.code`, `content.table`, `content.chart`, `content.map`, `content.drawing`, `content.status`, `content.image`, `content.progress`, `content.hitl`, `content.artifact`.

Use an approved artifact for unsupported custom visuals. Flowcharts/ERDs/sequences use the vendored Mermaid artifact bundle or authored SVG/Canvas, never a CDN.

## Exact local patch catalog

The MCP `board_scene_patch` applies these operations in order to a private clone, performs the authoritative per-operation and final D1 validation/size passes, and emits exactly one `scene.replace`:

1. `replace_root`
2. `replace_node`
3. `remove_node`
4. `insert_child`
5. `move_child`
6. `set_split_weight`
7. `set_grid_placement`
8. `set_canvas_rect`
9. `set_active_tab`
10. `upsert_drawing_element`
11. `remove_drawing_element`

Operations target `nodeId`, direct parent IDs, and exact placement. `replace_node` preserves identity; root changes use `replace_root`. A move cannot target the node or its descendant. Parent type, placement, grid bounds/overlap, tabs, canvas geometry, drawing IDs, duplicate identities, references, depth/count, and canonical byte limits are validated atomically. No partial state is sent.

Malformed IDs/indexes/root use/source-parent mismatch map to `INVALID_PAYLOAD`; duplicate identity to `DUPLICATE_NODE_ID`; structure/geometry/reference problems to `INVALID_LAYOUT`; catalog/count/byte breaches to `LIMIT_EXCEEDED` or `PAYLOAD_TOO_LARGE`. Final D1 parser errors remain exact.

The MCP-absent dependency-free adapter supports the same 11 operation names but does not embed the full D1/Zod runtime. It first verifies that the fetched head equals `expectedRevisionId`, applies structural transform checks, and sends one final `scene.replace`; the official server owns complete node, layout, limit, and error validation. Therefore, use MCP when descriptors exist and do not rely on fallback-local rejection timing as proof of full D1 validity.

## Replace versus patch

- Replace for a topic/layout reset or full redraw. Historical revisions remain immutable.
- Patch for an ordered change to known stable `NodeId` regions.
- Clear intentionally creates a blank restorable head.
- There is no transient/history-label mutation mode in v1.
