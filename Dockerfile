# Build stage: compile the React app and the API
FROM node:22-slim AS build
WORKDIR /app
COPY backend/package*.json backend/
RUN cd backend && npm ci
COPY frontend/package*.json frontend/
RUN cd frontend && npm ci
COPY backend backend
COPY frontend frontend
RUN cd backend && npm run build && cd ../frontend && npm run build

# Runtime stage: production dependencies only
FROM node:22-slim
ENV NODE_ENV=production FRONTEND_DIST=/app/frontend/dist
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/backend/dist dist
COPY backend/migrations migrations
COPY --from=build /app/frontend/dist /app/frontend/dist
EXPOSE 4000
# Migrate, seed demo data only if the database is empty, then start.
CMD ["sh", "-c", "node dist/migrate.js && node dist/seed.js && node dist/server.js"]
