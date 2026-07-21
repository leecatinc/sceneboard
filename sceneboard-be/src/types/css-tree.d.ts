declare module 'css-tree' {
  export type CssNode = {
    type: string;
    name?: string;
    property?: string;
  };

  export function parse(
    source: string,
    options: { context: 'stylesheet' | 'declarationList'; positions: boolean },
  ): CssNode;

  export function walk(node: CssNode, visit: (node: CssNode) => void): void;
}
