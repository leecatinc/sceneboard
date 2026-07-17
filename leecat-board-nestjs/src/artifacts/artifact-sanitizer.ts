import { parse as parseCss, walk as walkCss, type CssNode } from 'css-tree';
import { parseFragment, serialize } from 'parse5';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';

export type SanitizedArtifactSourceV1 = {
  html: string;
  css: string | null;
  javascript: string | null;
  sanitizerPolicyVersion: 1;
};

type HtmlAttribute = { name: string; value: string };
type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
};

const DISALLOWED_TAGS = new Set([
  'script', 'base', 'link', 'iframe', 'frame', 'object', 'embed', 'applet', 'form',
  'foreignobject',
]);
const DISALLOWED_ATTRIBUTES = new Set([
  'src', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'target', 'ping', 'download',
]);
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes']);

const invalid = (issue: string, path: Array<string | number>): BoardContractError => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return new BoardContractError(error);
};

const inspectCss = (
  source: string,
  context: 'stylesheet' | 'declarationList',
  counters: { rules: number; declarations: number },
  path: Array<string | number>,
): void => {
  let ast: CssNode;
  try {
    ast = parseCss(source, { context, positions: true });
  } catch {
    throw invalid('sanitizer_css_malformed', path);
  }
  walkCss(ast, (node) => {
    if (node.type === 'Rule') counters.rules += 1;
    if (node.type === 'Declaration') {
      counters.declarations += 1;
      const property = (node.property ?? '').toLowerCase();
      if (property === 'behavior' || property === '-moz-binding') throw invalid('sanitizer_css_binding', path);
    }
    if (node.type === 'Url') throw invalid('sanitizer_css_url', path);
    if (node.type === 'Function' && (node.name ?? '').toLowerCase().includes('image-set')) {
      throw invalid('sanitizer_css_url', path);
    }
    if (node.type === 'Atrule' && !ALLOWED_AT_RULES.has((node.name ?? '').toLowerCase())) {
      throw invalid('sanitizer_css_at_rule', path);
    }
  });
  if (counters.rules > 1_024) throw invalid('sanitizer_css_rule_count', path);
  if (counters.declarations > 16_384) throw invalid('sanitizer_css_declaration_count', path);
};

export class ArtifactSanitizerV1 {
  sanitize(input: { html: string; css: string | null; javascript: string | null }): SanitizedArtifactSourceV1 {
    const parseErrors: unknown[] = [];
    const fragment = parseFragment(input.html, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error),
    }) as HtmlNode;
    if (parseErrors.length > 0) throw invalid('sanitizer_html_malformed', ['html']);
    const counters = { rules: 0, declarations: 0 };
    let nodeCount = 0;
    const stack: Array<{ node: HtmlNode; depth: number }> = [{ node: fragment, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      nodeCount += 1;
      if (nodeCount > 10_000) throw invalid('sanitizer_node_count', ['html']);
      if (current.depth > 64) throw invalid('sanitizer_html_depth', ['html']);
      const tag = current.node.tagName?.toLowerCase();
      if (tag !== undefined) {
        if (DISALLOWED_TAGS.has(tag)) throw invalid('sanitizer_html_element', ['html']);
        const attrs = current.node.attrs ?? [];
        if (attrs.length > 64) throw invalid('sanitizer_attribute_count', ['html']);
        for (const attribute of attrs) {
          const name = attribute.name.toLowerCase();
          if (name.startsWith('on') || DISALLOWED_ATTRIBUTES.has(name)) {
            throw invalid('sanitizer_html_attribute', ['html']);
          }
          if (tag === 'meta' && name === 'http-equiv' && attribute.value.toLowerCase() === 'refresh') {
            throw invalid('sanitizer_html_element', ['html']);
          }
          if (name === 'style') inspectCss(attribute.value, 'declarationList', counters, ['html']);
        }
      }
      const children = current.node.childNodes ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push({ node: child, depth: current.depth + 1 });
      }
    }
    if (input.css !== null) inspectCss(input.css, 'stylesheet', counters, ['css']);
    return {
      html: serialize(fragment as never),
      css: input.css,
      javascript: input.javascript,
      sanitizerPolicyVersion: 1,
    };
  }
}
