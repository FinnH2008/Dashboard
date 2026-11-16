FROM node:24-alpine

# System-Tools für Festplatten, SMART, Archive, Video-Thumbnails & Docker Compose Stacks
RUN apk add --no-cache \
  util-linux \
  smartmontools \
  e2fsprogs \
  docker-cli \
  docker-cli-compose \
  zip \
  unzip \
  tar \
  ffmpeg \
  hdparm

WORKDIR /app

COPY package.json ./
COPY config ./config
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /app/data/stacks

ENV NODE_ENV=production
ENV PORT=3080
ENV DATA_DIR=/app/data

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3080/api/health || exit 1

CMD ["node", "src/server.js"]
