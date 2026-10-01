FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY scripts ./scripts
COPY eval ./eval
ENV NODE_ENV=production BLOB_DIR=/data/blobs HF_CACHE_DIR=/data/hf-cache PORT=8790
EXPOSE 8790
CMD ["npx", "tsx", "src/main.ts"]
