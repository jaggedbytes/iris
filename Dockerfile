FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

COPY server ./server
COPY frontend ./frontend
RUN cd frontend && npm run build
RUN cd server && npm run build

FROM node:24-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production

COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/frontend/dist ./public

EXPOSE 3001
CMD ["node", "dist/index.js"]
