# SceneBoard MCP runtime

The release pipeline places the reviewed, bundled `index.js` runtime in this directory.
The source plugin intentionally fails closed when that artifact is absent. Local development
uses the trusted project-root `.mcp.json` entry instead.
