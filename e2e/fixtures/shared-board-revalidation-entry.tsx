import React from 'react';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '../../sceneboard-fe/components/i18n/I18nProvider.js';
import type { SharedBoardActionState } from '../../sceneboard-fe/app/s/[shareToken]/shared-board-actions.js';
import { SharedBoardClient } from '../../sceneboard-fe/app/s/[shareToken]/shared-board-client.js';

declare global {
  interface Window {
    __sharedBoardFixture: Readonly<{
      bootstrapStates: readonly SharedBoardActionState[];
    }>;
    __sharedBoardHarness?: Readonly<{
      snapshot(): Readonly<{ bootstrapCalls: number; text: string }>;
    }>;
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new TypeError('shared board fixture root is unavailable');

let bootstrapCalls = 0;
const bootstrapAction = async (): Promise<SharedBoardActionState> => {
  const index = Math.min(bootstrapCalls, window.__sharedBoardFixture.bootstrapStates.length - 1);
  bootstrapCalls += 1;
  return window.__sharedBoardFixture.bootstrapStates[index] ?? { state: 'unavailable' };
};

createRoot(rootElement).render(
  <I18nProvider initialLocale="en">
    <SharedBoardClient
      bootstrapAction={bootstrapAction}
      passwordAction={async () => ({ state: 'unavailable' })}
    />
  </I18nProvider>,
);

window.__sharedBoardHarness = Object.freeze({
  snapshot: () => ({ bootstrapCalls, text: document.body.textContent ?? '' }),
});
