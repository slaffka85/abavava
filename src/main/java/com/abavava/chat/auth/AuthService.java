package com.abavava.chat.auth;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.User;
import com.abavava.chat.security.JwtService;
import com.abavava.chat.security.Passwords;
import com.abavava.chat.user.UserRepository;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.regex.Pattern;

/**
 * Сценарии аутентификации: регистрация, вход, ротация refresh-токена,
 * выход из сессии. Семантика повторяет auth/service.go в Go-реализации.
 */

@Service
@RequiredArgsConstructor
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private static final int MIN_PASSWORD_LENGTH = 8;
    private static final int MAX_PASSWORD_LENGTH = 72;
    private static final int MAX_EMAIL_LENGTH = 254;
    private static final int MAX_DISPLAY_NAME = 64;

    private static final Pattern EMAIL_PATTERN =
            Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    private final UserRepository users;
    private final RefreshTokenRepository tokens;
    private final JwtService jwt;
    private final AbvProperties props;

    public record SessionMeta(String userAgent, String ip) {
    }

    /** Выданная пара токенов вместе с профилем (JSON: camelCase → snake_case). */
    public record AuthResult(
            User user,
            @com.fasterxml.jackson.annotation.JsonProperty("access_token") String accessToken,
            @com.fasterxml.jackson.annotation.JsonProperty("refresh_token") String refreshToken,
            @com.fasterxml.jackson.annotation.JsonProperty("expires_in") int expiresIn
    ) {
    }

    public record RegisterInput(String email, String displayName, String password) {
    }

    public record LoginInput(String email, String password) {
    }

    public AuthResult register(RegisterInput input, SessionMeta meta) {
        String email = normalizeEmail(input.email());
        String name = normalizeDisplayName(input.displayName());
        //validatePassword(input.password());
        String hash = Passwords.hash(input.password());
        User account = users.createAccount(email, name, hash);
        return issue(account, meta);
    }

    public AuthResult login(LoginInput input, SessionMeta meta) {
        String login = normalizeLogin(input.email());
        UserRepository.Account account = users.accountByEmail(login);
        if (account == null) {
            Passwords.compareWithDummy(input.password());
            throw AbvException.unauthorized("invalid email or password");
        }
        if (!Passwords.matches(account.passwordHash(), input.password())) {
            throw AbvException.unauthorized("invalid email or password");
        }
        return issue(account.user(), meta);
    }

    public AuthResult refresh(String refreshToken, SessionMeta meta) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw AbvException.invalidField("refresh_token", "refresh_token is required");
        }
        String oldHash = Passwords.hashToken(refreshToken);
        String newToken = Passwords.randomToken(32);
        OffsetDateTime expiresAt = expiresAt(props.refreshTtl());
        java.util.UUID userId;
        try {
            userId = tokens.rotate(oldHash, Passwords.hashToken(newToken), meta.userAgent(), meta.ip(), expiresAt);
        } catch (RefreshTokenRepository.TokenReuseException reuse) {
            log.warn("refresh token reuse detected: user_id={}", reuse.userId());
            tokens.revokeAllForUser(reuse.userId());
            throw AbvException.unauthorized("session compromised, please sign in again");
        }
        User account = users.byId(userId);
        return result(account, newToken);
    }

    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        tokens.revoke(Passwords.hashToken(refreshToken));
    }

    public java.util.UUID verifyAccess(String raw) {
        return jwt.verifyAccessToken(raw);
    }

    public User authenticate(String raw) {
        return users.byId(verifyAccess(raw));
    }

    private AuthResult issue(User account, SessionMeta meta) {
        String refresh = Passwords.randomToken(32);
        tokens.insert(account.id(), Passwords.hashToken(refresh), meta.userAgent(), meta.ip(),
                expiresAt(props.refreshTtl()));
        return result(account, refresh);
    }

    private AuthResult result(User account, String refreshToken) {
        String access = jwt.issueAccessToken(account.id());
        return new AuthResult(account, access, refreshToken, (int) props.accessTtl().getSeconds());
    }

    private static OffsetDateTime expiresAt(Duration ttl) {
        return OffsetDateTime.now(ZoneOffset.UTC).plus(ttl);
    }

    // ----------------------------------------------------------- валидация

    /** Вход не проверяет формат email: демо-аккаунты могут иметь короткий логин. */
    private static String normalizeLogin(String raw) {
        String login = raw == null ? "" : raw.trim().toLowerCase();
        if (login.isEmpty()) {
            throw AbvException.unauthorized("invalid email or password");
        }
        if (login.length() > MAX_EMAIL_LENGTH) {
            throw AbvException.unauthorized("invalid email or password");
        }
        return login;
    }

    private static String normalizeEmail(String raw) {
        String email = raw == null ? "" : raw.trim().toLowerCase();
        if (email.isEmpty()) {
            throw AbvException.invalidField("email", "email is required");
        }
        if (email.length() > MAX_EMAIL_LENGTH) {
            throw AbvException.invalidField("email", "email is too long");
        }
        if (!EMAIL_PATTERN.matcher(email).matches()) {
            throw AbvException.invalidField("email", "email is invalid");
        }
        String domain = email.substring(email.indexOf('@') + 1);
        if (!domain.contains(".")) {
            throw AbvException.invalidField("email", "email domain is invalid");
        }
        return email;
    }

    private static String normalizeDisplayName(String raw) {
        String name = raw == null ? "" : raw.strip().replaceAll("\\s+", " ");
        if (name.isEmpty()) {
            throw AbvException.invalidField("display_name", "display_name is required");
        }
        if (name.codePointCount(0, name.length()) > MAX_DISPLAY_NAME) {
            throw AbvException.invalidField("display_name",
                    "display_name must be at most " + MAX_DISPLAY_NAME + " characters");
        }
        return name;
    }

    private static void validatePassword(String password) {
        String value = password == null ? "" : password;
        int bytes = value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        if (bytes < MIN_PASSWORD_LENGTH) {
            throw AbvException.invalidField("password",
                    "password must be at least " + MIN_PASSWORD_LENGTH + " characters");
        }
        if (bytes > MAX_PASSWORD_LENGTH) {
            throw AbvException.invalidField("password",
                    "password must be at most " + MAX_PASSWORD_LENGTH + " characters");
        }
        if (value.isBlank()) {
            throw AbvException.invalidField("password", "password must not be blank");
        }
    }
}
