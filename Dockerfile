FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# mount a volume at /data so the sqlite file survives restarts. No VOLUME line: Railway
# refuses Dockerfiles that have one
RUN mkdir /data && chown node:node /data
ENV DB_PATH=/data/monitor.db PORT=8787

USER node
EXPOSE 8787
CMD ["node", "src/node.js"]
