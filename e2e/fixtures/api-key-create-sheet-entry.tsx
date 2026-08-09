import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { ApiKeyCreateSheet } from '../../sceneboard-fe/app/settings/ai-connections/api-key-create-sheet.js';
import { I18nProvider } from '../../sceneboard-fe/components/i18n/I18nProvider.js';

declare global {
  interface Window {
    __apiKeyCreateHarness?: Readonly<{
      setBusy(value: boolean): void;
      submissions(): readonly unknown[];
    }>;
  }
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new TypeError('API-key fixture root is unavailable');

const submissions: unknown[] = [];
let updateBusy: ((value: boolean) => void) | null = null;

function Fixture() {
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  updateBusy = setBusy;
  return (
    <I18nProvider initialLocale="en">
      <ApiKeyCreateSheet
        busy={busy}
        triggerRef={triggerRef}
        onCreate={(input) => submissions.push(structuredClone(input))}
      />
    </I18nProvider>
  );
}

const root = createRoot(rootElement);
flushSync(() => root.render(<Fixture />));

window.__apiKeyCreateHarness = Object.freeze({
  setBusy(value) {
    if (updateBusy === null) throw new TypeError('API-key busy setter is unavailable');
    flushSync(() => updateBusy?.(value));
  },
  submissions() {
    return structuredClone(submissions);
  },
});
