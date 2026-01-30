FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY server.js .
COPY fellowship.pk .
COPY key.env .

ENV NODE_ENV=production

EXPOSE 8080 3001

CMD ["node", "server.js"]