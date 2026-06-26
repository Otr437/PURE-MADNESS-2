# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jdk-jammy AS builder
WORKDIR /build
COPY pom.xml ./
RUN apt-get update && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*
RUN mvn -B dependency:go-offline
COPY src/ ./src/
RUN mvn -B package -DskipTests

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre-jammy AS production
RUN groupadd -r raguser && useradd -r -g raguser -d /app -s /sbin/nologin raguser
WORKDIR /app
COPY --from=builder /build/target/rag-ai-java-1.0.0.jar ./app.jar
RUN mkdir -p /app/.rag_sessions_java && chown -R raguser:raguser /app
USER raguser
EXPOSE 8004
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8004/health || exit 1
CMD ["java", "-XX:+UseContainerSupport", "-XX:MaxRAMPercentage=75.0", "-jar", "app.jar"]
