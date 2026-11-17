# OpenAMS Firebase-mode container image: one image per release, configured per deployment
# at runtime. See docs/cloud-run.md. (The repository-root Dockerfile is the separate
# fictional-data preview behind IAP.)
#
#   docker build -f deploy/firebase.Dockerfile \
#     --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_APP_ID=... \
#     --build-arg NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY=... \
#     -t openams-firebase .
#
# The NEXT_PUBLIC_* values identify the Google Cloud project's Firebase web app. They are
# not secrets, they are compiled into the browser bundle, and they are the same for every
# deployment in that project. Everything per deployment (AMS_APP_URL, AMS_ADMIN_EMAIL,
# AMS_FIRESTORE_DATABASE, AMS_AUTH_TENANT_ID, AMS_STORAGE_BUCKET,
# AMS_SCHEDULER_SERVICE_ACCOUNT, AMS_STATUS_SERVICE_ACCOUNT) is runtime environment.
# Do not pass NEXT_PUBLIC_APP_URL here: it would be baked into the image.
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY
ENV NEXT_TELEMETRY_DISABLED=1 \
    AMS_AUTH_MODE=firebase \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.22.1-bookworm-slim
WORKDIR /app
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY
# The launcher checks the App Check site key at startup, so the build-time values are
# kept in the runtime environment too. They match what the browser bundle was built with.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    AMS_AUTH_MODE=firebase \
    PORT=8080 \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "scripts/firebase-start.mjs"]
