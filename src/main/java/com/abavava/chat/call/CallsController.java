package com.abavava.chat.call;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Call;
import com.abavava.chat.http.CurrentUser;
import com.abavava.chat.http.JsonBody;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.UUID;

/**
 * REST-эндпоинты звонков (call/handler.go в Go). Аутентификация — фильтром
 * (AccessTokenFilter), здесь только чтение id пользователя из запроса.
 */
@RestController
@RequestMapping("/api/v1")
public class CallsController {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final CallService calls;
    private final ObjectMapper mapper;

    public CallsController(CallService calls, ObjectMapper mapper) {
        this.calls = calls;
        this.mapper = mapper;
    }

    /** POST /api/v1/calls: {callee_id, kind?, conversation_id?}. */
    public record StartCallRequest(
            @JsonProperty("callee_id") UUID calleeId,
            @JsonProperty("kind") String kind,
            @JsonProperty("conversation_id") UUID conversationId) {
    }

    /** Необязательное тело accept/reject/end: {reason}. */
    public record ReasonRequest(
            @JsonProperty("reason") String reason) {
    }

    @PostMapping("/calls")
    public ResponseEntity<Map<String, Object>> start(HttpServletRequest request) {
        UUID actor = CurrentUser.userId(request);
        StartCallRequest body = JsonBody.required(request, StartCallRequest.class, mapper);
        Call call = calls.start(actor,
                new CallService.StartInput(body.calleeId(), body.kind(), body.conversationId()));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("call", call));
    }

    @GetMapping("/calls")
    public ResponseEntity<Map<String, Object>> history(HttpServletRequest request) {
        UUID actor = CurrentUser.userId(request);
        int limit = parseLimit(request.getParameter("limit"));
        return ResponseEntity.ok(Map.of("items", calls.history(actor, limit)));
    }

    @GetMapping("/calls/{id}")
    public ResponseEntity<Map<String, Object>> get(HttpServletRequest request,
                                                   @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        Call call = calls.get(actor, parseCallId(rawId));
        return ResponseEntity.ok(Map.of("call", call));
    }

    @PostMapping("/calls/{id}/accept")
    public ResponseEntity<Map<String, Object>> accept(HttpServletRequest request,
                                                      @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        Call call = calls.accept(actor, parseCallId(rawId));
        return ResponseEntity.ok(Map.of("call", call));
    }

    @PostMapping("/calls/{id}/reject")
    public ResponseEntity<Map<String, Object>> reject(HttpServletRequest request,
                                                      @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        Call call = calls.reject(actor, parseCallId(rawId), reason(request));
        return ResponseEntity.ok(Map.of("call", call));
    }

    @PostMapping("/calls/{id}/end")
    public ResponseEntity<Map<String, Object>> end(HttpServletRequest request,
                                                   @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        Call call = calls.end(actor, parseCallId(rawId), reason(request));
        return ResponseEntity.ok(Map.of("call", call));
    }

    private String reason(HttpServletRequest request) {
        ReasonRequest body = JsonBody.optional(request, ReasonRequest.class, mapper);
        return body == null || body.reason() == null ? "" : body.reason();
    }

    private static UUID parseCallId(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (RuntimeException e) {
            throw AbvException.invalidField("id", "call id must be a valid uuid");
        }
    }

    /** Как httpx.parseLimit в Go: не-число → default, больше 200 → 200. */
    private static int parseLimit(String raw) {
        if (raw == null || raw.isEmpty()) {
            return DEFAULT_LIMIT;
        }
        long value = 0;
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch < '0' || ch > '9') {
                return DEFAULT_LIMIT;
            }
            value = value * 10 + (ch - '0');
            if (value > MAX_LIMIT) {
                return MAX_LIMIT;
            }
        }
        return value <= 0 ? DEFAULT_LIMIT : (int) value;
    }
}
