package com.abavava.chat.auth;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.security.Passwords;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;

/**
 * refresh_tokens: хранение только SHA-256-хеша, ротация с обнаружением
 * повторного использования (см. auth/repo.go в Go).
 */
@Repository
@RequiredArgsConstructor
public class RefreshTokenRepository {

    /** Владелец отозванного токена предъявлен повторно — признак кражи. */
    public static class TokenReuseException extends RuntimeException {
        private final UUID userId;

        public TokenReuseException(UUID userId) {
            super("refresh token reuse detected");
            this.userId = userId;
        }

        public UUID userId() {
            return userId;
        }
    }

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;

    public void insert(UUID userId, String tokenHash, String userAgent, String ip, OffsetDateTime expiresAt) {
        jdbc.sql("""
                INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
                VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), ?)""")
                .param(userId)
                .param(tokenHash)
                .param(nullToEmpty(userAgent))
                .param(nullToEmpty(ip))
                .param(expiresAt)
                .update();
    }

    /**
     * Атомарная ротация: отзыв старого и вставка нового в одной транзакции.
     * Возвращает владельца токена.
     */
    public UUID rotate(String oldHash, String newHash, String userAgent, String ip, OffsetDateTime expiresAt) {
        return tx.execute(status -> {
            Optional<UUID> revoked = jdbc.sql("""
                            UPDATE refresh_tokens
                               SET revoked_at = now()
                             WHERE token_hash = ?
                               AND revoked_at IS NULL
                               AND expires_at > now()
                         RETURNING user_id""")
                    .param(oldHash)
                    .query(UUID.class)
                    .optional();

            if (revoked.isPresent()) {
                insert(revoked.get(), newHash, userAgent, ip, expiresAt);
                return revoked.get();
            }

            record State(UUID userId, boolean revoked) {
            }
            Optional<State> state = jdbc.sql(
                            "SELECT user_id, (revoked_at IS NOT NULL) AS revoked FROM refresh_tokens WHERE token_hash = ?")
                    .param(oldHash)
                    .query((rs, i) -> new State(rs.getObject("user_id", UUID.class), rs.getBoolean("revoked")))
                    .optional();
            if (state.isEmpty()) {
                throw AbvException.unauthorized("refresh token is not recognized");
            }
            if (state.get().revoked()) {
                throw new TokenReuseException(state.get().userId());
            }
            throw AbvException.unauthorized("refresh token expired");
        });
    }

    /** Отзыв токена по хешу; идемпотентно. */
    public void revoke(String tokenHash) {
        jdbc.sql("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ? AND revoked_at IS NULL")
                .param(tokenHash)
                .update();
    }

    /** Отзыв всех действующих токенов пользователя. */
    public void revokeAllForUser(UUID userId) {
        jdbc.sql("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL")
                .param(userId)
                .update();
    }

    /** Чистка отозванных/просроченных токенов по таймеру. */
    public long deleteExpired(Duration olderThan) {
        return jdbc.sql("""
                        DELETE FROM refresh_tokens
                         WHERE expires_at < now() - ?::interval
                            OR (revoked_at IS NOT NULL AND revoked_at < now() - ?::interval)""")
                .param(olderThan.toSeconds() + " seconds")
                .param(olderThan.toSeconds() + " seconds")
                .update();
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
