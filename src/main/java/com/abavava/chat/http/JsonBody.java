package com.abavava.chat.http;

import com.abavava.chat.domain.AbvException;
import jakarta.servlet.http.HttpServletRequest;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;

/** Чтение JSON-тела запроса с ошибками в формате Go httpx.DecodeJSON. */
public final class JsonBody {

    private JsonBody() {
    }

    /** Тело обязательно: пустое тело → invalid_request "request body is required". */
    public static <T> T required(HttpServletRequest request, Class<T> type, ObjectMapper mapper) {
        byte[] bytes = readBytes(request);
        if (bytes.length == 0) {
            throw AbvException.invalid("request body is required");
        }
        return parse(bytes, type, mapper);
    }

    /** Тело необязательно: пустое тело → null (для logout и опциональных reason). */
    public static <T> T optional(HttpServletRequest request, Class<T> type, ObjectMapper mapper) {
        byte[] bytes = readBytes(request);
        if (bytes.length == 0) {
            return null;
        }
        return parse(bytes, type, mapper);
    }

    private static byte[] readBytes(HttpServletRequest request) {
        try (InputStream in = request.getInputStream()) {
            return in.readAllBytes();
        } catch (IOException e) {
            throw AbvException.invalid("malformed json");
        }
    }

    private static <T> T parse(byte[] bytes, Class<T> type, ObjectMapper mapper) {
        try {
            return mapper.readValue(bytes, type);
        } catch (RuntimeException e) {
            throw AbvException.invalid("malformed json");
        }
    }
}
