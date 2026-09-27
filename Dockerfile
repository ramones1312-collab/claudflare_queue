# KAWA VECTOR · Edge Signal Buffer · NAS DEPLOYER IMAGE
#
# A tool to install and operate the Cloudflare Edge. NOT part of the trading runtime: it can be
# stopped (it exits after every command), it publishes no port, shares nothing with HUB_A and needs
# only outbound HTTPS to api.cloudflare.com / *.workers.dev.
#
# Reproducible: base image pinned by digest (node 22, Debian bookworm, multi-arch: amd64 + arm64);
# dependencies installed with `npm ci` from the committed lockfile (wrangler 4.132.0, vitest 2.1.9,
# @cloudflare/vitest-pool-workers 0.5.40). Never `latest`, never `npm audit fix`.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV KAWA_ROOT=/opt/kawa \
    KAWA_IN_CONTAINER=1 \
    KAWA_IMAGE=kawa-edge-deployer:1.3.1-nas-r3.3 \
    WRANGLER_SEND_METRICS=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# No apt layer: `script` (bsdutils, used only by the deployer's interactive-prompt tests) is already
# in the base image, and Node/wrangler use Node's bundled CA store for HTTPS.

# ---- layer 1: dependencies. Rebuilt ONLY when package.json / package-lock.json change. ----------
WORKDIR /opt/kawa/edge
COPY edge/package.json edge/package-lock.json ./
# Behind a TLS-inspecting proxy only: pass its CA as a BuildKit secret (never stored in the image):
#   docker compose build --build-arg HTTPS_PROXY=… (+ secret "npm_ca", see README_NAS_INSTALL §Proxy)
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi \
 && npm ci --no-audit --no-fund \
 && npm cache clean --force \
 # vitest writes its results cache here; the root filesystem is read-only at run time.
 && ln -s /tmp/kawa-vite node_modules/.vite

# ---- layer 2: code, docs, manifest. Cheap to rebuild. -----------------------------------------
COPY . /opt/kawa/
WORKDIR /opt/kawa
ENTRYPOINT ["node", "/opt/kawa/deployer/cli.mjs"]
CMD ["help"]
