# One image, six services. Which one runs is decided by CMD, not by the build, so every
# service is provably the same code.

FROM node:22.13.0-alpine@sha256:f2dc6eea95f787e25f173ba9904c9d0647ab2506178c7b5b7c5a3d02bc4af145 AS base
WORKDIR /app
RUN apk add --no-cache curl=8.12.1-r1 || apk add --no-cache curl

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc --project tsconfig.build.json

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

# Nothing here runs as root.
RUN addgroup -S agentkit && adduser -S agentkit -G agentkit
USER agentkit

CMD ["node", "dist/services/kernel/main.js"]
