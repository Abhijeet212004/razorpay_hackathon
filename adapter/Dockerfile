# The adapter. Built from the repository root so it can depend on packages/merchant the
# same way a merchant depends on @agentkit/merchant from a registry.
FROM node:22.13.0-alpine@sha256:f2dc6eea95f787e25f173ba9904c9d0647ab2506178c7b5b7c5a3d02bc4af145
WORKDIR /app

COPY packages/merchant ./packages/merchant
WORKDIR /app/adapter
COPY adapter/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY adapter/server.mjs adapter/mapping.mjs ./

# Nothing here holds a payment credential, so it runs unprivileged.
USER node
EXPOSE 7000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:7000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
