FROM node:22-trixie-slim

# ffmpeg with libass/harfbuzz/fribidi renders Arabic captions correctly.
ARG WHISPER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && if [ "$WHISPER" = "1" ]; then apt-get install -y --no-install-recommends python3 python3-pip \
      && pip3 install --no-cache-dir --break-system-packages faster-whisper; fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

ENV HOST=0.0.0.0 \
    PORT=4317 \
    LIVECUT_DATA=/data \
    HF_HOME=/data/models \
    NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4317
USER node
CMD ["node", "--import", "tsx", "src/server/index.ts"]
