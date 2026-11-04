package com.abavava.chat.http;

import com.abavava.chat.contract.RealtimeStats;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * GET /api/v1/status: число онлайн-пользователей и активных соединений.
 * Если realtime-слой не собран (например, в тестах) — нули.
 */
@RestController
public class StatusController {

    private final ObjectProvider<RealtimeStats> stats;

    public StatusController(ObjectProvider<RealtimeStats> stats) {
        this.stats = stats;
    }

    @GetMapping("/api/v1/status")
    public ResponseEntity<Map<String, Object>> status() {
        RealtimeStats s = stats.getIfAvailable();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("online_users", s == null ? 0 : s.onlineUsers());
        body.put("connections", s == null ? 0 : s.connections());
        body.put("server_time", Instant.now());
        return ResponseEntity.ok(body);
    }
}
