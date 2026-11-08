# syntax=docker/dockerfile:1
FROM maven:3.9-eclipse-temurin-26 AS build
WORKDIR /workspace
COPY pom.xml .
RUN mvn -B -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:26-jre
WORKDIR /app
COPY --from=build /workspace/target/abavava-0.1.0-SNAPSHOT.jar /app/app.jar
EXPOSE 8082
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
