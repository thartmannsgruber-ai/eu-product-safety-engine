# Apify Actor Node 22 Dockerfile
FROM apify/actor-node:22

COPY package*.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Dependencies installed."

CMD ["node", "apps/actor/dist/index.js"]
