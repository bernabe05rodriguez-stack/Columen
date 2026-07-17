# Debian slim (no Alpine): whatsapp-web.js necesita un Chromium real con sus libs.
FROM node:20-slim

ENV TZ=America/Argentina/Buenos_Aires
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Chromium del sistema + libs necesarias para correr headless en el contenedor.
# puppeteer NO descarga su propio Chromium (PUPPETEER_SKIP_DOWNLOAD): usamos el de apt.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      tzdata \
      fonts-liberation \
      fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --production && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 80
CMD ["node", "server.js"]
