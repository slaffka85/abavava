package com.abavava.chat.http;

import com.abavava.chat.domain.AbvException;

import jakarta.servlet.http.HttpServletRequest;

import java.util.UUID;

/** Доступ к аутентифицированному пользователю из атрибутов запроса. */
public final class CurrentUser {

    private CurrentUser() {
    }

    /** Id пользователя, установленный AccessTokenFilter; иначе unauthorized. */
    public static UUID userId(HttpServletRequest request) {
        Object raw = request.getAttribute(Httpx.USER_ID_ATTRIBUTE);
        if (raw instanceof UUID id) {
            return id;
        }
        throw AbvException.unauthorized("authentication required");
    }
}
