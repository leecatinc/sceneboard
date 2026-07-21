# SceneBoard MCP runtime

The release build places the reviewed, bundled `index.js` runtime in this directory. The public
plugin also carries a checksummed Linux profile-lease helper so a clean Codex marketplace install
can initialize the MCP server without running package lifecycle scripts. Local development still
prefers the trusted project-root `.mcp.json` entry.
