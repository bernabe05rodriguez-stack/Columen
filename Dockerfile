FROM node:20-alpine
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Argentina/Buenos_Aires /etc/localtime && \
    echo "America/Argentina/Buenos_Aires" > /etc/timezone
ENV TZ=America/Argentina/Buenos_Aires
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 80
CMD ["node", "server.js"]
