# Use Node 24 on Debian Bookworm Slim
FROM node:24-bookworm-slim

# Prevent interactive installation prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies required for Camoufox, Xvfb virtual display, Mesa GLX, and desktop fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    libgtk-3-0 \
    libasound2 \
    libdbus-glib-1-2 \
    libx11-xcb1 \
    libxtst6 \
    libnss3 \
    libxss1 \
    libgl1-mesa-dri \
    mesa-utils \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    ca-certificates \
    tini \
    curl \
    procps \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Centralized location for the Camoufox browser binary baked into the image
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox

# Copy dependency manifests first for Docker layer caching
COPY package*.json ./

# Install project dependencies
RUN npm ci

# Pre-fetch Camoufox Linux browser binary and GeoIP data into the image layer
RUN npx camoufox-js fetch

# Copy application source code
COPY . .

# Set default production environment variables
ENV NODE_ENV=production \
    HEADLESS=virtual \
    PORT=3000

# Expose the API server port
EXPOSE 3000

# Use tini as the init process to reap zombie browser processes cleanly
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the application
CMD ["node", "src/app.js"]
