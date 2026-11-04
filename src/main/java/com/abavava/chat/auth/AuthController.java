package com.abavava.chat.auth;

import com.abavava.chat.http.JsonBody;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

/** HTTP-эндпоинты аутентификации: /api/v1/auth/*. */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private static final int MAX_USER_AGENT = 256;
    private static final int MAX_IP = 64;

    private final AuthService auth;
    private final ObjectMapper mapper;

    public AuthController(AuthService auth, ObjectMapper mapper) {
        this.auth = auth;
        this.mapper = mapper;
    }

    public record RegisterRequest(
            @JsonProperty("email") String email,
            @JsonProperty("display_name") String displayName,
            @JsonProperty("password") String password) {
    }

    public record LoginRequest(
            @JsonProperty("email") String email,
            @JsonProperty("password") String password) {
    }

    public record RefreshRequest(
            @JsonProperty("refresh_token") String refreshToken) {
    }

    @PostMapping("/register")
    public ResponseEntity<AuthService.AuthResult> register(HttpServletRequest request) {
        RegisterRequest body = JsonBody.required(request, RegisterRequest.class, mapper);
        AuthService.AuthResult result = auth.register(
                new AuthService.RegisterInput(body.email(), body.displayName(), body.password()), meta(request));
        return ResponseEntity.status(201).body(result);
    }

    @PostMapping("/login")
    public ResponseEntity<AuthService.AuthResult> login(HttpServletRequest request) {
        LoginRequest body = JsonBody.required(request, LoginRequest.class, mapper);
        return ResponseEntity.ok(auth.login(new AuthService.LoginInput(body.email(), body.password()), meta(request)));
    }

    @PostMapping("/refresh")
    public ResponseEntity<AuthService.AuthResult> refresh(HttpServletRequest request) {
        RefreshRequest body = JsonBody.required(request, RefreshRequest.class, mapper);
        return ResponseEntity.ok(auth.refresh(body.refreshToken(), meta(request)));
    }

    /** Идемпотентно: 204 и без тела, даже если токен не передан. */
    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request) {
        RefreshRequest body = JsonBody.optional(request, RefreshRequest.class, mapper);
        auth.logout(body == null ? null : body.refreshToken());
        return ResponseEntity.noContent().build();
    }

    private static AuthService.SessionMeta meta(HttpServletRequest request) {
        String agent = request.getHeader("User-Agent");
        String ip = com.abavava.chat.http.Httpx.clientIp(request);
        return new AuthService.SessionMeta(truncate(agent, MAX_USER_AGENT), truncate(ip, MAX_IP));
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return "";
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}
