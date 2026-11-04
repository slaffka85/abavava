package com.abavava.chat.user;

import com.abavava.chat.contract.UserLookup;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.User;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Доступ к таблице users. SQL повторяет user/repo.go, маппинг строк —
 * явный (PDO: Domain-Driven Design с ручным RowMapper для 1:1-паритета).
 */
@Repository
@RequiredArgsConstructor
public class UserRepository implements UserLookup {

    private final JdbcClient jdbc;

    static final String USER_COLUMNS = "id, email, display_name, avatar_url, created_at, last_seen_at";

    private static final RowMapper<User> MAPPER = (rs, rowNum) -> mapUser(rs);

    static User mapUser(ResultSet rs) throws SQLException {
        return new User(
                rs.getObject("id", UUID.class),
                rs.getString("email"),
                rs.getString("display_name"),
                rs.getString("avatar_url"),
                instant(rs, "created_at"),
                instant(rs, "last_seen_at"));
    }

    static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    /** Создаёт пользователя; повторный email → 409 conflict. */
    public User createAccount(String email, String displayName, String passwordHash) {
        try {
            return jdbc.sql("INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?) RETURNING "
                            + USER_COLUMNS)
                    .param(email)
                    .param(displayName)
                    .param(passwordHash)
                    .query(MAPPER)
                    .single();
        } catch (org.springframework.dao.DuplicateKeyException e) {
            throw AbvException.conflict("email is already registered");
        }
    }

    /** Профиль и хеш пароля для входа; null, если пользователя нет. */
    public record Account(User user, String passwordHash) {
    }

    public Account accountByEmail(String login) {
        record Row(User user, String hash) {
        }
        Optional<Row> row = jdbc.sql("SELECT " + USER_COLUMNS + ", password_hash FROM users WHERE lower(email) = lower(?)")
                .param(login)
                .query((rs, i) -> new Row(mapUser(rs), rs.getString("password_hash")))
                .optional();
        return row.map(r -> new Account(r.user(), r.hash())).orElse(null);
    }

    /** Поиск по подстроке имени/email, исключая себя. */
    public List<User> search(String query, UUID excludeId, int limit) {
        int capped = limit <= 0 || limit > 50 ? 20 : limit;
        String q = query == null ? "" : query.trim();
        return jdbc.sql("SELECT " + USER_COLUMNS + "\n"
                        + "FROM users\n"
                        + "WHERE id <> ?\n"
                        + "  AND (? = '' OR display_name ILIKE '%' || ? || '%' OR email ILIKE '%' || ? || '%')\n"
                        + "ORDER BY lower(display_name), id\n"
                        + "LIMIT ?")
                .param(excludeId)
                .param(q)
                .param(q)
                .param(q)
                .param(capped)
                .query(MAPPER)
                .list();
    }

    /** Обновление профиля: null-поля остаются без изменений, пустой avatar_url очищает. */
    public User updateProfile(UUID id, String displayName, boolean avatarProvided, String avatarUrl) {
        Optional<User> updated = jdbc.sql("UPDATE users\n"
                        + "   SET display_name = COALESCE(?, display_name),\n"
                        + "       avatar_url   = CASE WHEN ? THEN ? ELSE avatar_url END\n"
                        + " WHERE id = ?\n"
                        + " RETURNING " + USER_COLUMNS)
                .param(displayName)
                .param(avatarProvided)
                .param(avatarUrl)
                .param(id)
                .query(MAPPER)
                .optional();
        return updated.orElseThrow(() -> AbvException.notFound("user not found"));
    }

    @Override
    public User byId(UUID id) {
        User found = findById(id);
        if (found == null) {
            throw AbvException.notFound("user not found");
        }
        return found;
    }

    @Override
    public User findById(UUID id) {
        return jdbc.sql("SELECT " + USER_COLUMNS + " FROM users WHERE id = ?")
                .param(id)
                .query(MAPPER)
                .optional()
                .orElse(null);
    }

    @Override
    public void touchLastSeen(UUID id) {
        jdbc.sql("UPDATE users SET last_seen_at = now() WHERE id = ?").param(id).update();
    }
}
