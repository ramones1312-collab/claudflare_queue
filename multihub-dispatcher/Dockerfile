# KAWA VECTOR · Multi-Hub Dispatcher V0.1
# Works with the classic builder (Synology Container Manager, BuildKit OFF): no RUN --mount, no npm install.
# Zero npm dependencies: SQLite is node:sqlite, built into Node 22.
FROM node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json VERSION ./
COPY src ./src
RUN mkdir -p /data /config /secrets
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.mjs"]
