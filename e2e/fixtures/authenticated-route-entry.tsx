import React from 'react';
import { createRoot } from 'react-dom/client';

import { AuthenticatedRoute } from '../../sceneboard-fe/components/app/AuthenticatedRoute.js';
import { I18nProvider } from '../../sceneboard-fe/components/i18n/I18nProvider.js';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new TypeError('authenticated route fixture root is unavailable');

createRoot(rootElement).render(
  <I18nProvider initialLocale="en">
    <AuthenticatedRoute>
      <main>Boards ready</main>
    </AuthenticatedRoute>
  </I18nProvider>,
);
