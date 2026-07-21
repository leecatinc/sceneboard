import { Fragment, type ReactNode } from 'react';

import { tokenizeSafeMarkdownV1 } from './safe-markdown.js';

const renderInlineContent = (text: string): ReactNode[] => {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('*') && part.endsWith('*'))
        return <em key={index}>{part.slice(1, -1)}</em>;
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={index}>{part.slice(1, -1)}</code>;
      return <Fragment key={index}>{part}</Fragment>;
    });
};

export function SafeMarkdownContent({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {tokenizeSafeMarkdownV1(markdown).map((token, index) => {
        if (token.type === 'heading') {
          if (token.level === 1) return <h3 key={index}>{renderInlineContent(token.text)}</h3>;
          if (token.level === 2) return <h4 key={index}>{renderInlineContent(token.text)}</h4>;
          return <h5 key={index}>{renderInlineContent(token.text)}</h5>;
        }
        if (token.type === 'quote')
          return <blockquote key={index}>{renderInlineContent(token.text)}</blockquote>;
        if (token.type === 'code')
          return (
            <pre key={index}>
              <code>{token.text}</code>
            </pre>
          );
        if (token.type === 'separator') return <hr key={index} />;
        if (token.type === 'unordered-item')
          return (
            <div className="scene-list-item" key={index}>
              • {renderInlineContent(token.text)}
            </div>
          );
        if (token.type === 'ordered-item')
          return (
            <div className="scene-list-item" key={index}>
              {index + 1}. {renderInlineContent(token.text)}
            </div>
          );
        return <p key={index}>{renderInlineContent(token.text)}</p>;
      })}
    </div>
  );
}
