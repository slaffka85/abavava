package com.abavava.chat.http;

import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Служебные эндпоинты: liveness (/healthz) и readiness с пингом БД (/readyz).
 * Доступны и без префикса /api/v1 — как в Go-реализации.
 */
@RestController
public class HealthController {

    private final JdbcTemplate jdbc;

    public HealthController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping({"/healthz", "/api/v1/healthz"})
    public ResponseEntity<Map<String, Object>> healthz() {
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @GetMapping({"/readyz", "/api/v1/readyz"})
    public ResponseEntity<Map<String, Object>> readyz() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            return ResponseEntity.ok(Map.of("status", "ok", "db", "ok"));
        } catch (RuntimeException e) {
            return ResponseEntity.status(503).body(Map.of("status", "degraded", "db", "down"));
        }
    }
}
