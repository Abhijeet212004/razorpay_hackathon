# The merchant's own application. A MERN app on MongoDB — a stack the trust kernel cannot
# use and does not need to. Nothing here knows what a mandate is.
#
# Built from the repository root so the storefront can depend on packages/merchant the
# same way a real merchant depends on @agentkit/merchant from a registry.
FROM node:22.13.0-alpine@sha256:f2dc6eea95f787e25f173ba9904c9d0647ab2506178c7b5b7c5a3d02bc4af145 AS base
WORKDIR /app
RUN apk add --no-cache curl

FROM base AS frontend
COPY storefront/frontend/package.json storefront/frontend/package-lock.json* ./frontend/
RUN cd frontend && npm install --legacy-peer-deps --no-audit --no-fund
COPY storefront/frontend ./frontend
RUN cd frontend && npm run build

FROM base AS runtime
ENV NODE_ENV=production
# The SDK first: it is a file dependency, so it must exist before npm install resolves it.
COPY packages/merchant ./packages/merchant
WORKDIR /app/storefront
COPY storefront/package.json storefront/package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps
COPY storefront/backend ./backend
COPY storefront/server.js ./
COPY --from=frontend /app/frontend/build ./frontend/build
EXPOSE 4000
CMD ["node", "server.js"]
