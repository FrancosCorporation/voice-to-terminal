FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public
RUN mkdir -p /workspace /data \
    && chown node:node /workspace /data \
    && chmod 700 /data

USER node
EXPOSE 3000
CMD ["node", "server.js"]
