# Multi-platform MCP server Dockerfile for Glama & container environments
FROM node:22-alpine

WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY fixtures/ ./fixtures/
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN npm install --include=dev \
 && npm run build

# Runs the Model Context Protocol (MCP) server via stdio
CMD ["node", "apps/mcp/dist/index.js"]
