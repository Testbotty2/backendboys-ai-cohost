FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

# System dependencies required by Puppeteer's bundled Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libxshmfence1 libpango-1.0-0 libcairo2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs fingerprint.mjs apply-antidetection.mjs ADVANCED-ISOLATION.md ./

# Anti-detection is natively integrated — no patching needed

RUN useradd --system --uid 10001 --create-home juniors \
    && mkdir -p /tmp/juniors-ai-chat-runtimes \
    && chown -R juniors:juniors /app /tmp/juniors-ai-chat-runtimes

USER 10001

EXPOSE 10000

CMD ["node", "server.mjs"]
