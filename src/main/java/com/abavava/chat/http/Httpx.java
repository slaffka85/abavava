package com.abavava.chat.http;

import com.abavava.chat.domain.AbvException;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * Общие помощники HTTP-слоя: единый формат ошибок, IP клиента, проверка
 * Origin (та же логика, что httpx.OriginAllowed в Go) и извлечение токена.
 */
public final class Httpx {

    public static final String USER_ID_ATTRIBUTE = "abv.user_id";
    public static final String REQUEST_ID_ATTRIBUTE = "abv.request_id";

    private Httpx() {
    }

    /** Тело ошибки в формате docs/API.md: {"error": {"code","message","details"}}. */
    public record ErrorEnvelope(@JsonProperty("error") ErrorDetail error) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ErrorDetail(
            @JsonProperty("code") String code,
            @JsonProperty("message") String message,
            @JsonProperty("details") Map<String, Object> details
    ) {
    }

    public static ErrorEnvelope envelope(AbvException e) {
        return new ErrorEnvelope(new ErrorDetail(e.code().json(), e.getMessage(), e.details()));
    }

    public static void writeJson(HttpServletResponse response, int status, Object body, ObjectMapper mapper)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/json; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (body != null) {
            mapper.writeValue(response.getOutputStream(), body);
        }
    }

    public static void writeError(HttpServletResponse response, AbvException e, ObjectMapper mapper)
            throws IOException {
        writeJson(response, e.code().httpStatus(), envelope(e), mapper);
    }

    /** IP клиента: X-Forwarded-For (первый адрес) либо RemoteAddr без порта. */
    public static String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            int comma = forwarded.indexOf(',');
            String first = (comma >= 0 ? forwarded.substring(0, comma) : forwarded).trim();
            if (!first.isEmpty()) {
                return first;
            }
        }
        return hostOnly(request.getRemoteAddr());
    }

    /** host:port → host (IPv6-литералы в скобках сохраняются). */
    public static String hostOnly(String hostport) {
        if (hostport == null) {
            return "";
        }
        String host = hostport.trim();
        int idx = host.lastIndexOf(':');
        if (idx > 0 && !host.endsWith("]") && host.indexOf(':', idx + 1) < 0) {
            host = host.substring(0, idx);
        }
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1);
        }
        return host;
    }

    /**
     * Решение о доверии источнику (CORS и Origin WebSocket-рукопожатия),
     * повторяет правила httpx.OriginAllowed:
     * 1) нет Origin (не браузер) — trust;
     * 2) точное/шаблонное совпадение с abv.allowed-origins;
     * 3) тот же узел, что и у запроса.
     */
    public static boolean originAllowed(String origin, String requestHost, List<String> allowed) {
        if (origin == null || origin.isBlank()) {
            return true;
        }
        URI parsed;
        try {
            parsed = URI.create(origin.trim());
        } catch (IllegalArgumentException e) {
            return false;
        }
        if (parsed.getHost() == null) {
            return false;
        }
        for (String pattern : allowed) {
            if (originMatches(parsed, pattern)) {
                return true;
            }
        }
        return parsed.getHost().equalsIgnoreCase(hostOnly(requestHost));
    }

    private static boolean originMatches(URI origin, String pattern) {
        if (pattern == null || pattern.isBlank()) {
            return false;
        }
        String p = pattern.trim();

        String scheme = null;
        String rest = p;
        int schemeIdx = p.indexOf("://");
        if (schemeIdx >= 0) {
            scheme = p.substring(0, schemeIdx);
            rest = p.substring(schemeIdx + 3);
        }
        // Паттерны задаются без пути, но на всякий случай обрежем его.
        int slash = rest.indexOf('/');
        if (slash >= 0) {
            rest = rest.substring(0, slash);
        }

        String port = null;
        if (rest.startsWith("[")) {
            int closing = rest.indexOf(']');
            if (closing < 0) {
                return false;
            }
            if (closing + 1 < rest.length() && rest.charAt(closing + 1) == ':') {
                port = rest.substring(closing + 2);
            }
            rest = rest.substring(0, closing + 1);
        } else {
            int colon = rest.lastIndexOf(':');
            if (colon > 0) {
                port = rest.substring(colon + 1);
                rest = rest.substring(0, colon);
            }
        }
        if (scheme != null && !scheme.equalsIgnoreCase(origin.getScheme())) {
            return false;
        }
        if (port != null && !port.isEmpty()) {
            try {
                if (Integer.parseInt(port) != origin.getPort()) {
                    return false;
                }
            } catch (NumberFormatException e) {
                return false;
            }
        }
        String host = rest.toLowerCase();
        String originHost = origin.getHost().toLowerCase();
        if (host.startsWith("*.")) {
            String wildcard = host.substring(2);
            return originHost.endsWith("." + wildcard) && !originHost.equals(wildcard);
        }
        return originHost.equals(host);
    }

    public static String bearerToken(HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header == null || header.isBlank()) {
            return null;
        }
        String[] parts = header.split(" ", 2);
        if (parts.length != 2 || !parts[0].equalsIgnoreCase("bearer")) {
            return null;
        }
        String token = parts[1].trim();
        return token.isEmpty() ? null : token;
    }

    /** Токен из заголовка или (для WebSocket-рукопожатия) из query-параметра token. */
    public static String tokenFromRequest(HttpServletRequest request) {
        String t = bearerToken(request);
        if (t != null) {
            return t;
        }
        String q = request.getParameter("token");
        return q == null || q.isBlank() ? null : q.trim();
    }
}
