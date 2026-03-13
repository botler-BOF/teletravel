FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

ENV PORT=8080
ENV ADMIN_PASSWORD=teletravel2026

EXPOSE 8080

CMD ["node", "admin/server.js"]
