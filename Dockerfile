FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs README.md ADVANCED-ISOLATION.md ./
RUN useradd --system --uid 10001 --create-home juniors && mkdir -p /tmp/juniors-ai-chat-runtimes && chown -R juniors:juniors /app /tmp/juniors-ai-chat-runtimes
USER 10001
EXPOSE 10000
CMD ["node","server.mjs"]
