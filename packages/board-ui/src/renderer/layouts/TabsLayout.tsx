'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import type { RendererComponentV1 } from '../renderer-types.js';

export const TabsLayout: RendererComponentV1<'layout.tabs'> = ({ node, context, renderNode }) => {
  const seeded = context.selectedTabs[node.id] ?? node.activeTabId;
  const [localTab, setLocalTab] = useState(seeded);
  const selected = node.tabs.some((tab) => tab.tabId === seeded) ? seeded : localTab;
  const current = node.tabs.find((tab) => tab.tabId === selected) ?? node.tabs[0];
  const id = useId();
  if (current === undefined) return null;
  const select = (tabId: string) => {
    setLocalTab(tabId);
    context.onSelectTab?.(node.id, tabId);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0
      : event.key === 'End' ? node.tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + node.tabs.length) % node.tabs.length;
    const tab = node.tabs[target];
    if (tab !== undefined) select(tab.tabId);
  };
  return (
    <section className="scene-layout scene-tabs" aria-label={node.title ?? 'Tabs'}>
      <div role="tablist" aria-label={node.title ?? 'Scene tabs'} className="scene-tab-list">
        {node.tabs.map((tab, index) => (
          <button
            id={`${id}-tab-${index}`}
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === current.tabId}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={tab.tabId === current.tabId ? 0 : -1}
            className="scene-tab"
            onClick={() => select(tab.tabId)}
            onKeyDown={(event) => keyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel-${node.tabs.indexOf(current)}`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${node.tabs.indexOf(current)}`}
        className="scene-tab-panel"
      >
        {renderNode(current.node)}
      </div>
    </section>
  );
};
