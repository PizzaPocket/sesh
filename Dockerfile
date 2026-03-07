FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
EXPOSE 8080
CMD ["node", "server/index.js"]
