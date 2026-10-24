FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/server.js ./
COPY index.html sw.js manifest.webmanifest icon-192.png icon-512.png ./public/
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
