# Ingest List — production image
# Node 22 LTS Alpine — small, fast, no native deps needed (we use plain JSON storage)

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Chromium (+ fonts/libs) for server-side PDF rendering via puppeteer-core.
# puppeteer-core does NOT download its own browser — it uses this system one.
RUN apk add --no-cache \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Install only production deps via clean install for reproducibility
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Copy application sources
COPY server.js database.js ./
COPY public ./public
COPY portfolio ./portfolio

# Persistent data dir (mounted as volume)
RUN mkdir -p /app/data && chown -R node:node /app

# Drop privileges
USER node

EXPOSE 3000

# Lightweight HTTP healthcheck — /healthz is unauthenticated and side-effect-free
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
