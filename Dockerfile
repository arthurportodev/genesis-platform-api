FROM node:24-alpine3.24 AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM alpine:3.24 AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libstdc++ \
  && addgroup -S -g 10001 genesis \
  && adduser -S -D -H -u 10001 -G genesis genesis
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/main.js"]
