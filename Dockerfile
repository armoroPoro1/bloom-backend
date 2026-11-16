FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=development HOST=0.0.0.0 PORT=4000
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /app/var/uploads /app/var/mail && chown -R node:node /app/var
USER node
EXPOSE 4000
CMD ["node","dist/src/server.js"]

