export const composeArtifactInnerDocumentV1 = (
  input: Readonly<{
    policy: string;
    mermaidTag: string;
    threeTag: string;
    resourcesTag: string;
    bootstrapTag: string;
    html: string;
  }>,
): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${input.policy}"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden}</style>${input.resourcesTag}${input.bootstrapTag}${input.threeTag}${input.mermaidTag}</head><body>${input.html}</body></html>`;
