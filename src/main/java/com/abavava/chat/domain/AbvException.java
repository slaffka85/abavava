package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * Доменная ошибка с кодом, безопасным для клиента текстом и деталями
 * (например, именем проблемного поля). Аналог internal/domain/errors.go.
 */
public class AbvException extends RuntimeException {

    /** Коды ошибок, общие для REST и WebSocket (docs/API.md). */
    public enum Code {
        INVALID_REQUEST("invalid_request", 400),
        VALIDATION_FAILED("validation_failed", 422),
        UNAUTHORIZED("unauthorized", 401),
        FORBIDDEN("forbidden", 403),
        NOT_FOUND("not_found", 404),
        CONFLICT("conflict", 409),
        RATE_LIMITED("rate_limited", 429),
        INTERNAL("internal", 500);

        private final String json;
        private final int httpStatus;

        Code(String json, int httpStatus) {
            this.json = json;
            this.httpStatus = httpStatus;
        }

        public String json() {
            return json;
        }

        public int httpStatus() {
            return httpStatus;
        }
    }

    private final Code code;
    private final Map<String, Object> details;

    public AbvException(Code code, String message, Map<String, Object> details, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.details = details;
    }

    public Code code() {
        return code;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public Map<String, Object> details() {
        return details;
    }

    public static AbvException invalid(String message) {
        return new AbvException(Code.INVALID_REQUEST, message, null, null);
    }

    public static AbvException invalid(String message, Object... args) {
        return new AbvException(Code.INVALID_REQUEST, format(message, args), null, null);
    }

    public static AbvException invalidField(String field, String message) {
        return new AbvException(Code.VALIDATION_FAILED, message, Map.of("field", field), null);
    }

    public static AbvException invalidField(String field, String message, Object... args) {
        return invalidField(field, format(message, args));
    }

    public static AbvException unauthorized(String message) {
        return new AbvException(Code.UNAUTHORIZED, message, null, null);
    }

    public static AbvException forbidden(String message) {
        return new AbvException(Code.FORBIDDEN, message, null, null);
    }

    public static AbvException notFound(String message) {
        return new AbvException(Code.NOT_FOUND, message, null, null);
    }

    public static AbvException notFound(String message, Object... args) {
        return new AbvException(Code.NOT_FOUND, format(message, args), null, null);
    }

    public static AbvException conflict(String message) {
        return new AbvException(Code.CONFLICT, message, null, null);
    }

    public static AbvException conflict(String message, Object... args) {
        return new AbvException(Code.CONFLICT, format(message, args), null, null);
    }

    public static AbvException internal(Throwable cause) {
        return new AbvException(Code.INTERNAL, "internal error", null, cause);
    }

    private static String format(String message, Object... args) {
        return args == null || args.length == 0 ? message : String.format(message, args);
    }
}
