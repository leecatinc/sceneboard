FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

WORKDIR /app
COPY deploy/sceneboard-be-export/runtime-packages.lock /tmp/runtime-packages.lock
RUN apt-get update \
    && xargs -r apt-get install -y --no-install-recommends </tmp/runtime-packages.lock \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm ci \
    && npm run build --workspace=sceneboard-be \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/sceneboard/ms-playwright \
       SCENEBOARD_EXPORT_RUNTIME_ROOT=/opt/sceneboard \
       npm run install:export-runtime \
    && rm -rf node_modules \
    && npm ci --omit=dev \
       --workspace=sceneboard-be \
       --include-workspace-root=false \
       --ignore-scripts \
    && npm audit --omit=dev \
       --workspace=sceneboard-be \
       --include-workspace-root=false

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/sceneboard/ms-playwright
ENV SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE=/opt/sceneboard/ms-playwright/chromium-1217/chrome-linux64/chrome
CMD ["node", "--import", "tsx", "sceneboard-be/dist/main.js"]
