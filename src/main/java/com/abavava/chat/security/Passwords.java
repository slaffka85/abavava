package com.abavava.chat.security;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

/**
 * Пароли и refresh-токены (internal/auth/password.go в Go):
 * bcrypt cost 12, пароль не длиннее 72 байт (жёсткое ограничение алгоритма),
 * refresh-токен — 32 случайных байта base64url, в БД только SHA-256 hex.
 */
public final class Passwords {

    private static final BCryptPasswordEncoder ENCODER = new BCryptPasswordEncoder(12);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int MAX_PASSWORD_BYTES = 72;
    private static final Base64.Encoder B64E = Base64.getUrlEncoder().withoutPadding();

    /** Валидный bcrypt-хеш случайного пароля: сравниваем с ним, когда пользователь
     *  не найден, чтобы время ответа не выдавало существование аккаунта. */
    private static final String DUMMY_HASH =
            "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7WBvE2fJ6x9Zx0JmQO6n3n9gS0aVJ0u";

    private Passwords() {
    }

    public static String hash(String password) {
        if (password == null || password.getBytes(StandardCharsets.UTF_8).length > MAX_PASSWORD_BYTES) {
            throw new IllegalArgumentException("password exceeds " + MAX_PASSWORD_BYTES + " bytes");
        }
        return ENCODER.encode(password);
    }

    public static boolean matches(String hash, String password) {
        if (hash == null || password == null) {
            return false;
        }
        try {
            return ENCODER.matches(password, hash);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public static void compareWithDummy(String password) {
        ENCODER.matches(password == null ? "" : password, DUMMY_HASH);
    }

    /** Криптослучайный refresh-токен (32 байта, base64url без паддинга). */
    public static String randomToken(int bytes) {
        byte[] buf = new byte[bytes];
        RANDOM.nextBytes(buf);
        return B64E.encodeToString(buf);
    }

    /** SHA-256 hex от токена: в БД хранится только хеш. */
    public static String hashToken(String token) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
