package com.abavava.chat.user;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.User;
import com.abavava.chat.http.CurrentUser;
import com.abavava.chat.http.JsonBody;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Профиль и поиск пользователей (user/handler.go в Go). */
@RestController
@RequestMapping("/api/v1")
public class UserController {

    private static final int MAX_AVATAR_URL_LENGTH = 512;
    private static final int MAX_DISPLAY_NAME = 64;

    private final UserRepository users;
    private final ObjectMapper mapper;

    public UserController(UserRepository users, ObjectMapper mapper) {
        this.users = users;
        this.mapper = mapper;
    }

    @GetMapping("/me")
    public ResponseEntity<Map<String, Object>> me(HttpServletRequest request) {
        UUID userId = CurrentUser.userId(request);
        return ResponseEntity.ok(Map.of("user", users.byId(userId)));
    }

    public record UpdateMeRequest(
            @JsonProperty("display_name") String displayName,
            @JsonProperty("avatar_url") String avatarUrl) {
    }

    @PatchMapping("/me")
    public ResponseEntity<Map<String, Object>> updateMe(HttpServletRequest request) {
        UUID userId = CurrentUser.userId(request);
        UpdateMeRequest body = JsonBody.required(request, UpdateMeRequest.class, mapper);
        if (body.displayName() == null && body.avatarUrl() == null) {
            throw AbvException.invalid("nothing to update: provide display_name or avatar_url");
        }
        String displayName = null;
        if (body.displayName() != null) {
            displayName = body.displayName().strip().replaceAll("\\s+", " ");
            if (displayName.isEmpty()) {
                throw AbvException.invalidField("display_name", "display_name must not be blank");
            }
            if (displayName.codePointCount(0, displayName.length()) > MAX_DISPLAY_NAME) {
                throw AbvException.invalidField("display_name",
                        "display_name must be at most " + MAX_DISPLAY_NAME + " characters");
            }
        }
        boolean avatarProvided = body.avatarUrl() != null;
        String avatarUrl = null;
        if (avatarProvided) {
            avatarUrl = body.avatarUrl().strip();
            if (avatarUrl.length() > MAX_AVATAR_URL_LENGTH) {
                throw AbvException.invalidField("avatar_url", "avatar_url is too long");
            }
            if (!avatarUrl.isEmpty() && !avatarUrl.startsWith("http://") && !avatarUrl.startsWith("https://")) {
                throw AbvException.invalidField("avatar_url", "avatar_url must be an http(s) URL");
            }
            if (avatarUrl.isEmpty()) {
                avatarUrl = null;
            }
        }
        User updated = users.updateProfile(userId, displayName, avatarProvided, avatarUrl);
        return ResponseEntity.ok(Map.of("user", updated));
    }

    @GetMapping("/users")
    public ResponseEntity<Map<String, Object>> search(HttpServletRequest request) {
        UUID userId = CurrentUser.userId(request);
        String query = request.getParameter("q");
        String q = query == null ? "" : query.trim();
        if (q.codePointCount(0, q.length()) > 64) {
            throw AbvException.invalidField("q", "query is too long");
        }
        int limit = parseLimit(request.getParameter("limit"), 20, 50);
        List<User> found = users.search(q, userId, limit);
        return ResponseEntity.ok(Map.of("items", found));
    }

    @GetMapping("/users/{id}")
    public ResponseEntity<Map<String, Object>> getById(HttpServletRequest request, @PathVariable("id") String rawId) {
        CurrentUser.userId(request);
        UUID id = parseUuid(rawId);
        return ResponseEntity.ok(Map.of("user", users.byId(id)));
    }

    private static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (RuntimeException e) {
            throw AbvException.invalidField("id", "id must be a valid uuid");
        }
    }

    private static int parseLimit(String raw, int def, int max) {
        if (raw == null || raw.isEmpty()) {
            return def;
        }
        long value = 0;
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch < '0' || ch > '9') {
                return def;
            }
            value = value * 10 + (ch - '0');
            if (value > max) {
                return max;
            }
        }
        return value <= 0 ? def : (int) value;
    }
}
