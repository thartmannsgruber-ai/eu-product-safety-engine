# Apify Actor Node 22 Dockerfile
FROM apify/actor-node:22

COPY package*.json tsconfig*.json ./
COPY fixtures/ ./fixtures/
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN npm --quiet set progress=false \
 && npm install \
 && npm run build \
 && echo "Dependencies installed and build finished."

CMD ["node", "apps/actor/dist/index.js"]
