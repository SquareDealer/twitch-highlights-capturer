# The web service (not the Electron app): Node service + Python detector + streamlink + ffmpeg.
# Node 24 (npm 11): the version the lockfile was written with; npm 10 refuses it in `npm ci`.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# One virtualenv for the detector's dependencies and streamlink; its bin is first on PATH,
# so the config defaults (`python`, `streamlink`, `ffmpeg`) work as they are.
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN python3 -m venv /opt/venv \
 && pip install --no-cache-dir numpy onnxruntime websockets streamlink

WORKDIR /app

# Dependencies first: this layer is rebuilt only when the lockfile changes. Electron is a dev
# dependency of the desktop app; its binary is not needed here.
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund

# The Silero VAD model (v5) is not in the repository.
ARG SILERO_VAD_URL=https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx
RUN mkdir -p detector/models && curl -fsSL "$SILERO_VAD_URL" -o detector/models/silero_vad.onnx

COPY . .
RUN npm run web:build \
 && cd detector && python -c "import numpy as np; from hl_detector.vad import SileroVad; SileroVad().prob(np.zeros(1600, dtype='float32'))"

# Configuration and data live outside the image (see docker-compose.yml).
ENV NODE_ENV=production HL_CONFIG=/config/config.json HL_DATA=/data
VOLUME ["/config", "/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:8080/ || exit 1

# Run the service directly (no npm in between) so SIGTERM reaches it and unfinished clips are cut before exit.
CMD ["node_modules/.bin/tsx", "src/service/main.ts"]
