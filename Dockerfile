FROM node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2 AS builder
SHELL ["/bin/sh", "-euxc"]
ARG METEOR_RELEASE=3.5.1
ARG METEOR_INSTALLER_RELEASE=3.5
ARG METEOR_INSTALLER_SHA512=sha512-nQC+Pk/xa81soxt7qTvtwg4vsrNMuwqsNjAemxBBm50u+fi/oArtrSqoQFccYjaA1tKnT/IAEHv+X+MYPrPukA==
ENV METEOR_ALLOW_SUPERUSER=true \
    npm_config_ignore_meteor_setup_exec_path=true \
    PATH=/root/.meteor:${PATH}
# The official npm package is the Meteor installer. Pin its release instead of
# executing a mutable remote shell script. Its original archive is verified
# before a reviewed lock replaces the installer's vulnerable tar 6 dependency.
COPY deployment/security-v7/runtime/meteor-installer/ /tmp/meteor-installer-policy/
RUN npm pack "meteor@${METEOR_RELEASE}" --pack-destination /tmp \
    && node -e "const fs=require('fs'),crypto=require('crypto');const [file,expected]=process.argv.slice(1);const actual='sha512-'+crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');if(actual!==expected){throw new Error('Meteor installer integrity mismatch')}" \
      "/tmp/meteor-${METEOR_RELEASE}.tgz" "${METEOR_INSTALLER_SHA512}" \
    && mkdir /tmp/meteor-installer \
    && tar xzf "/tmp/meteor-${METEOR_RELEASE}.tgz" -C /tmp/meteor-installer --strip-components=1 \
    && cp /tmp/meteor-installer-policy/package.json /tmp/meteor-installer/package.json \
    && cp /tmp/meteor-installer-policy/npm-shrinkwrap.json /tmp/meteor-installer/npm-shrinkwrap.json \
    && cd /tmp/meteor-installer \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && npm_config_global=true node cli.js install \
    && cd / \
    && rm -rf "/tmp/meteor-${METEOR_RELEASE}.tgz" /tmp/meteor-installer /tmp/meteor-installer-policy \
    && test "$(meteor --version)" = "Meteor ${METEOR_INSTALLER_RELEASE}" \
    && test "$(meteor node -p 'process.versions.modules')" = "$(node -p 'process.versions.modules')"
WORKDIR /app/
COPY package.json .
COPY package-lock.json .
COPY deployment/security-v7/eslint-build.config.mjs ./deployment/security-v7/
COPY rspack.config.js .
RUN meteor npm ci --no-audit \
    && rm -rf node_modules/meteor-node-stubs/node_modules/qs
COPY public/ ./public/
COPY server/ ./server/
COPY client/ ./client/
COPY imports/ ./imports/
COPY .meteor/ ./.meteor/
ENV DISABLE_CLIENT_STATS=true \
    METEOR_DISABLE_OPTIMISTIC_CACHING=1
RUN test "$(tr -d '\r\n' < .meteor/release)" = "METEOR@${METEOR_RELEASE}" \
    && test "$(meteor --version)" = "Meteor ${METEOR_RELEASE}" \
    && meteor npm exec -- eslint \
      --config deployment/security-v7/eslint-build.config.mjs \
      client server imports \
    && meteor build /build/ --server-only

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies
SHELL ["/bin/sh", "-euxc"]
RUN apk add --no-cache --virtual .build-deps g++ make python3
COPY --from=builder /build/*.tar.gz /app/bundle.tar.gz
# Meteor's generated server manifest pins obsolete build helpers. Replace it
# with reviewed, integrity-bearing manifests before strict, script-limited npm
# installs. The email overlay retains the Meteor package API while updating its
# vulnerable bundled npm dependencies.
COPY deployment/security-v7/runtime/server/ /app/server-runtime/
COPY deployment/security-v7/runtime/email/ /app/email-runtime/
COPY deployment/security-v7/remove-bundled-vulnerabilities.mjs /app/remove-bundled-vulnerabilities.mjs
WORKDIR /app/
RUN tar xzf bundle.tar.gz \
    && rm bundle.tar.gz \
    && cp server-runtime/package.json bundle/programs/server/package.json \
    && cp server-runtime/npm-shrinkwrap.json bundle/programs/server/npm-shrinkwrap.json \
    && cd /app/bundle/programs/server \
    && npm ci --omit=dev --prefer-offline --no-audit --no-fund \
    && cd /app/bundle/programs/server/npm/node_modules/meteor/email \
    && rm -rf node_modules \
    && cp /app/email-runtime/package.json package.json \
    && cp /app/email-runtime/npm-shrinkwrap.json npm-shrinkwrap.json \
    && npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund \
    && node /app/remove-bundled-vulnerabilities.mjs \
      /app/bundle/programs/server/npm/node_modules/meteor \
      /app/bundle/programs/server/npm/node_modules \
    && rm -rf /app/server-runtime /app/email-runtime /app/remove-bundled-vulnerabilities.mjs \
    && apk del .build-deps

FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
SHELL ["/bin/sh", "-euxc"]
ARG TITRA_VERSION
ARG VCS_REF
ARG SOURCE_CONTEXT_SHA256
RUN printf '%s' "${TITRA_VERSION}" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$' \
    && ! printf '%s' "${TITRA_VERSION}" | grep -Eiq '^(latest|unknown|uncommitted|default)$' \
    && printf '%s' "${VCS_REF}" | grep -Eq '^[0-9a-f]{40}$' \
    && printf '%s' "${SOURCE_CONTEXT_SHA256}" | grep -Eq '^[0-9a-f]{64}$'
LABEL org.opencontainers.image.title="titra" \
      org.opencontainers.image.source="https://github.com/titraio/titra" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${TITRA_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      io.titra.source-context.sha256="${SOURCE_CONTEXT_SHA256}"
ENV PORT=3000 \
    NODE_ENV=production
EXPOSE 3000
WORKDIR /app/
COPY --from=dependencies --chown=node:node /app/bundle bundle
COPY --chown=node:node --chmod=0555 entrypoint.sh /docker/entrypoint.sh
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/'},res=>{res.resume();process.exit(res.statusCode<500?0:1)});req.setTimeout(4000,()=>req.destroy());req.on('error',()=>process.exit(1));"]
ENTRYPOINT ["/docker/entrypoint.sh"]
CMD ["node", "bundle/main.js"]
