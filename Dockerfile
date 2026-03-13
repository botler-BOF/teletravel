FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

RUN git config --global user.email "admin@myteletravel.com" && \
    git config --global user.name "MyTeletravel Admin"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

ENV PORT=8080
ENV ADMIN_PASSWORD=teletravel2026

EXPOSE 8080

CMD ["node", "admin/server.js"]
