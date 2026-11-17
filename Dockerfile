FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# the sqlite file lives on a volume so it survives container restarts
RUN mkdir /data && chown node:node /data
VOLUME /data
ENV DB_PATH=/data/monitor.db PORT=8787

USER node
EXPOSE 8787
CMD ["node", "src/node.js"]
