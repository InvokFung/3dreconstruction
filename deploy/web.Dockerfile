# syntax=docker/dockerfile:1.7
# Frontend build + nginx. Build context: repository root.
#   docker build -f deploy/web.Dockerfile -t recon-web .
FROM node:22-alpine AS build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Empty VITE_API_URL = same origin (nginx proxies /api).
ARG VITE_API_URL=""
ARG VITE_BASE=/
ENV VITE_API_URL=${VITE_API_URL} VITE_BASE=${VITE_BASE}
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
