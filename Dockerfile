FROM node:24-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src/backend
COPY backend/pom.xml ./
COPY backend/src ./src
COPY --from=web /src/frontend/dist /src/frontend/dist
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre-alpine AS runtime
RUN addgroup -S swp && adduser -S -G swp swp && mkdir -p /app/data && chown -R swp:swp /app
WORKDIR /app
COPY --from=build --chown=swp:swp /src/backend/target/swp-shop-0.2.0.jar /app/swp-shop.jar
ENV SHOP_BIND_ADDRESS=0.0.0.0 PORT=8001 SHOP_IMPORT_ENABLED=false
USER swp
EXPOSE 8001
ENTRYPOINT ["java", "-jar", "/app/swp-shop.jar"]
