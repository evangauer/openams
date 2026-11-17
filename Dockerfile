# Evaluation image: the fictional evaluation build, either as a private preview behind
# Google IAP (docs/hosted-preview.md) or, with AMS_PREVIEW=public, as a public demo with
# a private sandbox per visitor (docs/public-demo.md). Not a production deployment.
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --workspace @openams/contracts \
 && npm run build --workspace @openams/api \
 && npm run build --workspace @openams/web

FROM node:24.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "scripts/preview.mjs"]
