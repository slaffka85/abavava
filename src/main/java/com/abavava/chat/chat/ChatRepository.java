package com.abavava.chat.chat;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Conversation;
import com.abavava.chat.domain.ConversationKind;
import com.abavava.chat.domain.ConversationView;
import com.abavava.chat.domain.MemberRole;
import com.abavava.chat.domain.Message;
import com.abavava.chat.domain.MessageKind;
import com.abavava.chat.domain.User;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Доступ к conversations / conversation_members / messages.
 *
 * <p>SQL — построчный перенос chat/repo.go (имена параметров сохранены в
 * комментариях, позиционные {@code ?} идут в порядке появления в тексте
 * запроса). Маппинг строк — явный RowMapper по правилам user.UserRepository.
 * Ошибки БД транслируются в доменные: нарушение внешнего ключа (SQLState
 * 23503) и уникальности (23505) различаются явно.
 */
@Repository
public class ChatRepository {

    static final String CONVERSATION_COLUMNS =
            "c.id, c.kind, c.title, c.created_by, c.created_at, c.updated_at, c.last_message_at";
    static final String MESSAGE_COLUMNS =
            "m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.client_id, m.created_at, m.edited_at, m.deleted_at";
    static final String USER_COLUMNS =
            "u.id, u.email, u.display_name, u.avatar_url, u.created_at, u.last_seen_at";

    private static final RowMapper<Conversation> CONVERSATION_MAPPER = (rs, i) -> mapConversation(rs);
    private static final RowMapper<Message> MESSAGE_MAPPER = (rs, i) -> mapMessage(rs);
    private static final RowMapper<User> USER_MAPPER = (rs, i) -> mapUser(rs);

    /** INSERT участника: повторный insert того же участника — не ошибка (как в Go). */
    private static final String INSERT_MEMBER = """
            INSERT INTO conversation_members (conversation_id, user_id, role)
            VALUES (?, ?, ?)
            ON CONFLICT (conversation_id, user_id) DO NOTHING""";

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;

    public ChatRepository(JdbcClient jdbc, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.tx = tx;
    }

    // ------------------------------------------------------------ row mapping

    static Conversation mapConversation(ResultSet rs) throws SQLException {
        return new Conversation(
                rs.getObject("id", UUID.class),
                ConversationKind.fromJson(rs.getString("kind")),
                rs.getString("title"),
                rs.getObject("created_by", UUID.class),
                instant(rs, "created_at"),
                instant(rs, "updated_at"),
                instant(rs, "last_message_at"));
    }

    static Message mapMessage(ResultSet rs) throws SQLException {
        return new Message(
                rs.getObject("id", UUID.class),
                rs.getObject("conversation_id", UUID.class),
                rs.getObject("sender_id", UUID.class),
                MessageKind.fromJson(rs.getString("kind")),
                rs.getString("body"),
                rs.getString("client_id"),
                instant(rs, "created_at"),
                instant(rs, "edited_at"),
                instant(rs, "deleted_at"));
    }

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

    // ---------------------------------------------------------------- helpers

    /** Канонический ключ пары: одинаков для (a,b) и (b,a) (см. DirectKey в Go). */
    public static String directKey(UUID a, UUID b) {
        String first = a.toString();
        String second = b.toString();
        if (first.compareTo(second) > 0) {
            String swap = first;
            first = second;
            second = swap;
        }
        return first + ":" + second;
    }

    private static String placeholders(int count) {
        return String.join(",", Collections.nCopies(count, "?"));
    }

    private static boolean hasSqlState(Throwable error, String state) {
        for (Throwable cursor = error; cursor != null; cursor = cursor.getCause()) {
            if (cursor instanceof SQLException sql && state.equals(sql.getSQLState())) {
                return true;
            }
            if (cursor.getCause() == cursor) {
                break;
            }
        }
        return false;
    }

    /** Нарушение внешнего ключа (23503): пользователя/диалога не существует. */
    static boolean isForeignKeyViolation(Throwable error) {
        return hasSqlState(error, "23503");
    }

    /** Нарушение уникальности (23505). */
    static boolean isUniqueViolation(Throwable error) {
        return hasSqlState(error, "23505");
    }

    // ------------------------------------------------------------ conversations

    /**
     * EnsureDirect находит или создаёт личный диалог двух пользователей.
     * created=false, если диалог уже существовал.
     */
    public DirectOutcome ensureDirect(UUID actor, UUID peerId) {
        String key = directKey(actor, peerId);
        return tx.execute(status -> {
            // INSERT ... ON CONFLICT (direct_key) DO NOTHING RETURNING: пусто → диалог уже есть.
            Optional<Conversation> inserted = jdbc.sql(
                            "INSERT INTO conversations AS c (kind, direct_key, created_by) "
                                    + "VALUES ('direct', ?, ?) "
                                    + "ON CONFLICT (direct_key) DO NOTHING "
                                    + "RETURNING " + CONVERSATION_COLUMNS)
                    .param(key)
                    .param(actor)
                    .query(CONVERSATION_MAPPER)
                    .optional();

            boolean created = inserted.isPresent();
            Conversation conversation;
            if (created) {
                conversation = inserted.get();
            } else {
                conversation = jdbc.sql("SELECT " + CONVERSATION_COLUMNS
                                + " FROM conversations c WHERE c.direct_key = ?")
                        .param(key)
                        .query(CONVERSATION_MAPPER)
                        .single();
            }

            // Оба участника должны быть в составе: обязательный шаг для нового
            // диалога и страховка от частично созданных данных для старого.
            insertMember(conversation.id(), actor, MemberRole.MEMBER,
                    AbvException.notFound("user not found"));
            insertMember(conversation.id(), peerId, MemberRole.MEMBER,
                    AbvException.notFound("peer user not found"));

            return new DirectOutcome(conversation, created);
        });
    }

    /** CreateGroup создаёт групповой диалог: создатель становится владельцем. */
    public Conversation createGroup(UUID actor, String title, List<UUID> memberIds) {
        return tx.execute(status -> {
            Conversation conversation = jdbc.sql(
                            "INSERT INTO conversations AS c (kind, title, created_by) "
                                    + "VALUES ('group', ?, ?) RETURNING " + CONVERSATION_COLUMNS)
                    .param(title)
                    .param(actor)
                    .query(CONVERSATION_MAPPER)
                    .single();

            insertMember(conversation.id(), actor, MemberRole.OWNER,
                    AbvException.internal(new IllegalStateException("group owner insert failed")));

            for (UUID memberId : memberIds) {
                if (memberId.equals(actor)) {
                    continue;
                }
                insertMember(conversation.id(), memberId, MemberRole.MEMBER,
                        AbvException.invalid("member %s does not exist", memberId));
            }
            return conversation;
        });
    }

    /** Диалог без проверки прав (проверка — в сервисе). */
    public Conversation conversationById(UUID id) {
        return jdbc.sql("SELECT " + CONVERSATION_COLUMNS + " FROM conversations c WHERE c.id = ?")
                .param(id)
                .query(CONVERSATION_MAPPER)
                .optional()
                .orElseThrow(() -> AbvException.notFound("conversation not found"));
    }

    /**
     * Роль пользователя в диалоге. Отсутствие строки означает «не участник» и
     * маскируется под not_found: посторонний не должен узнать о диалоге.
     */
    public MemberRole memberRole(UUID conversationId, UUID userId) {
        Optional<String> role = jdbc.sql(
                        "SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
                .param(conversationId)
                .param(userId)
                .query((rs, i) -> rs.getString("role"))
                .optional();
        return role.map(MemberRole::fromJson)
                .orElseThrow(() -> AbvException.notFound("conversation not found"));
    }

    /** Идентификаторы участников диалога. */
    public List<UUID> memberIds(UUID conversationId) {
        return jdbc.sql("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
                .param(conversationId)
                .query((rs, i) -> rs.getObject("user_id", UUID.class))
                .list();
    }

    /** Пользователи, с которыми у пользователя есть общие диалоги (рассылка presence). */
    public List<UUID> peersOf(UUID userId) {
        return jdbc.sql("""
                        SELECT DISTINCT other.user_id
                          FROM conversation_members mine
                          JOIN conversation_members other ON other.conversation_id = mine.conversation_id
                         WHERE mine.user_id = ?
                           AND other.user_id <> ?""")
                .param(userId)
                .param(userId)
                .query((rs, i) -> rs.getObject("user_id", UUID.class))
                .list();
    }

    /**
     * Страница диалогов пользователя с последним сообщением, участниками и
     * числом непрочитанных. Keyset-пагинация по (COALESCE(last_message_at, epoch), id).
     */
    public List<ConversationView> listConversations(UUID viewer, int limit, Cursor cursor) {
        int effective = limitOrDefault(limit);
        // null-курсор: ?::timestamptz IS NULL отключает условие пагинации.
        OffsetDateTime cursorTs = cursor == null ? null : OffsetDateTime.ofInstant(cursor.sortKey(), ZoneOffset.UTC);
        UUID cursorId = cursor == null ? null : cursor.id();

        List<ConversationRow> rows = jdbc.sql("""
                        SELECT c.id, c.kind, c.title, c.created_by, c.created_at, c.updated_at, c.last_message_at,
                               (SELECT count(*)
                                  FROM messages m
                                 WHERE m.conversation_id = c.id
                                   AND m.deleted_at IS NULL
                                   AND m.sender_id IS DISTINCT FROM ?
                                   AND m.created_at > COALESCE(cm.last_read_at, to_timestamp(0))) AS unread_count
                          FROM conversations c
                          JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
                         WHERE ?::timestamptz IS NULL
                            OR (COALESCE(c.last_message_at, to_timestamp(0)), c.id) < (?::timestamptz, ?::uuid)
                         ORDER BY COALESCE(c.last_message_at, to_timestamp(0)) DESC, c.id DESC
                         LIMIT ?""")
                .param(viewer)
                .param(viewer)
                .param(cursorTs)
                .param(cursorTs)
                .param(cursorId)
                .param(effective)
                .query((rs, i) -> new ConversationRow(mapConversation(rs), rs.getInt("unread_count")))
                .list();
        if (rows.isEmpty()) {
            return List.of();
        }

        List<UUID> ids = new ArrayList<>(rows.size());
        for (ConversationRow row : rows) {
            ids.add(row.conversation().id());
        }
        Map<UUID, List<User>> membersByConversation = membersByConversation(ids);
        Map<UUID, Message> lastByConversation = lastMessagesByConversation(ids);

        List<ConversationView> views = new ArrayList<>(rows.size());
        for (ConversationRow row : rows) {
            UUID id = row.conversation().id();
            List<User> members = membersByConversation.get(id);
            views.add(new ConversationView(
                    row.conversation(),
                    members == null ? List.of() : members,
                    lastByConversation.get(id),
                    row.unread()));
        }
        return views;
    }

    /** Представление одного диалога для конкретного зрителя. */
    public ConversationView conversationView(UUID conversationId, UUID viewer) {
        Conversation conversation = conversationById(conversationId);
        List<User> members = members(conversationId);
        Message last = lastMessage(conversationId);
        int unread = unreadCount(conversationId, viewer);
        return new ConversationView(conversation, members, last, unread);
    }

    private int unreadCount(UUID conversationId, UUID viewer) {
        Long unread = jdbc.sql("""
                        SELECT count(*)
                          FROM messages m
                          JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
                         WHERE m.conversation_id = ?
                           AND m.deleted_at IS NULL
                           AND m.sender_id IS DISTINCT FROM ?
                           AND m.created_at > COALESCE(cm.last_read_at, to_timestamp(0))""")
                .param(viewer)
                .param(conversationId)
                .param(viewer)
                .query(Long.class)
                .optional()
                .orElse(0L);
        return unread.intValue();
    }

    /** Участники диалога. */
    public List<User> members(UUID conversationId) {
        return jdbc.sql("SELECT " + USER_COLUMNS + """
                          FROM conversation_members cm
                          JOIN users u ON u.id = cm.user_id
                         WHERE cm.conversation_id = ?
                         ORDER BY lower(u.display_name), u.id""")
                .param(conversationId)
                .query(USER_MAPPER)
                .list();
    }

    /** Участники сразу для нескольких диалогов (IN вместо ANY(массив)). */
    private Map<UUID, List<User>> membersByConversation(List<UUID> ids) {
        if (ids.isEmpty()) {
            return Map.of();
        }
        JdbcClient.StatementSpec spec = jdbc.sql(
                "SELECT cm.conversation_id, " + USER_COLUMNS + """
                          FROM conversation_members cm
                          JOIN users u ON u.id = cm.user_id
                         WHERE cm.conversation_id IN (""" + placeholders(ids.size()) + """
                        )
                         ORDER BY cm.conversation_id, lower(u.display_name), u.id""");
        for (UUID id : ids) {
            spec = spec.param(id);
        }
        List<MemberRow> rows = spec
                .query((rs, i) -> new MemberRow(rs.getObject("conversation_id", UUID.class), mapUser(rs)))
                .list();

        Map<UUID, List<User>> out = new LinkedHashMap<>();
        for (MemberRow row : rows) {
            out.computeIfAbsent(row.conversationId(), key -> new ArrayList<>()).add(row.user());
        }
        return out;
    }

    /** Последнее сообщение диалога (null, если сообщений нет). */
    public Message lastMessage(UUID conversationId) {
        return jdbc.sql("SELECT " + MESSAGE_COLUMNS + """
                          FROM messages m
                         WHERE m.conversation_id = ? AND m.deleted_at IS NULL
                         ORDER BY m.created_at DESC, m.id DESC
                         LIMIT 1""")
                .param(conversationId)
                .query(MESSAGE_MAPPER)
                .optional()
                .orElse(null);
    }

    private Map<UUID, Message> lastMessagesByConversation(List<UUID> ids) {
        if (ids.isEmpty()) {
            return Map.of();
        }
        JdbcClient.StatementSpec spec = jdbc.sql(
                "SELECT DISTINCT ON (m.conversation_id) " + MESSAGE_COLUMNS + """
                          FROM messages m
                         WHERE m.conversation_id IN (""" + placeholders(ids.size()) + """
                        ) AND m.deleted_at IS NULL
                         ORDER BY m.conversation_id, m.created_at DESC, m.id DESC""");
        for (UUID id : ids) {
            spec = spec.param(id);
        }
        List<Message> rows = spec.query(MESSAGE_MAPPER).list();

        Map<UUID, Message> out = new LinkedHashMap<>();
        for (Message message : rows) {
            out.putIfAbsent(message.conversationId(), message);
        }
        return out;
    }

    // --------------------------------------------------------------- messages

    /**
     * Сохраняет сообщение. Если сообщение с таким client_id уже есть
     * (повторная отправка при обрыве связи), возвращается оно же с created=false:
     * идемпотентность обеспечивает частичный уникальный индекс в БД.
     */
    public Inserted insertMessage(UUID conversationId, UUID senderId, MessageKind kind, String body, String clientId) {
        String client = clientId == null ? "" : clientId;
        Optional<Message> inserted;
        try {
            inserted = jdbc.sql("INSERT INTO messages AS m (conversation_id, sender_id, kind, body, client_id)\n"
                            + "VALUES (?, ?, ?, ?, NULLIF(?, ''))\n"
                            + "ON CONFLICT (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING\n"
                            + "RETURNING " + MESSAGE_COLUMNS)
                    .param(conversationId)
                    .param(senderId)
                    .param(kind.json())
                    .param(body)
                    .param(client)
                    .query(MESSAGE_MAPPER)
                    .optional();
        } catch (DataIntegrityViolationException e) {
            if (isForeignKeyViolation(e)) {
                throw AbvException.notFound("conversation not found");
            }
            if (isUniqueViolation(e)) {
                throw AbvException.conflict("message already exists");
            }
            throw e;
        }
        if (inserted.isPresent()) {
            return new Inserted(inserted.get(), true);
        }

        // Конфликт по client_id: возвращаем ранее созданное сообщение.
        Optional<Message> existing = jdbc.sql("SELECT " + MESSAGE_COLUMNS + """
                          FROM messages m
                         WHERE m.conversation_id = ? AND m.sender_id = ? AND m.client_id = ?""")
                .param(conversationId)
                .param(senderId)
                .param(client)
                .query(MESSAGE_MAPPER)
                .optional();
        if (existing.isEmpty()) {
            throw AbvException.internal(new IllegalStateException(
                    "idempotent message is missing: conversation=" + conversationId + " client_id=" + client));
        }
        return new Inserted(existing.get(), false);
    }

    /**
     * Страница сообщений диалога. Запрос идёт от новых к старым (limit+1 для
     * has_more), в выдачу сообщения попадают в хронологическом порядке.
     */
    public MessagePage messages(UUID conversationId, int limit, UUID before) {
        int effective = limit <= 0 || limit > 200 ? 50 : limit;
        List<Message> items = new ArrayList<>(jdbc.sql("SELECT " + MESSAGE_COLUMNS + """
                          FROM messages m
                         WHERE m.conversation_id = ?
                           AND m.deleted_at IS NULL
                           AND (?::uuid IS NULL OR (m.created_at, m.id) < (
                                 SELECT anchor.created_at, anchor.id FROM messages anchor WHERE anchor.id = ?::uuid))
                         ORDER BY m.created_at DESC, m.id DESC
                         LIMIT ?""")
                .param(conversationId)
                .param(before)
                .param(before)
                .param(effective + 1)
                .query(MESSAGE_MAPPER)
                .list());

        boolean hasMore = items.size() > effective;
        if (hasMore) {
            items = new ArrayList<>(items.subList(0, effective));
        }
        items.sort(chronological());
        return new MessagePage(items, hasMore);
    }

    /**
     * Сдвигает указатель прочтения вперёд (назад — никогда).
     * Нет строки участника → not_found("conversation not found").
     */
    public Instant markRead(UUID conversationId, UUID userId, UUID messageId) {
        Optional<Instant> readAt = jdbc.sql("""
                        UPDATE conversation_members cm
                           SET last_read_message_id = ?,
                               last_read_at = GREATEST(
                                   COALESCE(cm.last_read_at, to_timestamp(0)),
                                   COALESCE((SELECT anchor.created_at
                                               FROM messages anchor
                                              WHERE anchor.id = ? AND anchor.conversation_id = ?),
                                            to_timestamp(0)))
                         WHERE cm.conversation_id = ? AND cm.user_id = ?
                         RETURNING COALESCE(last_read_at, to_timestamp(0))""")
                .param(messageId)
                .param(messageId)
                .param(conversationId)
                .param(conversationId)
                .param(userId)
                // RETURNING без псевдонима даёт колонку "coalesce" — читаем по индексу.
                .query((rs, i) -> {
                    OffsetDateTime value = rs.getObject(1, OffsetDateTime.class);
                    return value == null ? null : value.toInstant();
                })
                .optional();
        return readAt.orElseThrow(() -> AbvException.notFound("conversation not found"));
    }

    /** Добавляет участников в групповой диалог (повторный insert — не ошибка). */
    public void addMembers(UUID conversationId, List<UUID> userIds) {
        for (UUID userId : userIds) {
            try {
                jdbc.sql(INSERT_MEMBER)
                        .param(conversationId)
                        .param(userId)
                        .param(MemberRole.MEMBER.json())
                        .update();
            } catch (DataIntegrityViolationException e) {
                if (isForeignKeyViolation(e)) {
                    throw AbvException.invalid("user %s does not exist", userId);
                }
                throw e;
            }
        }
    }

    /** Удаляет участника; нет строки → not_found("member not found"). */
    public void removeMember(UUID conversationId, UUID userId) {
        int removed = jdbc.sql("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
                .param(conversationId)
                .param(userId)
                .update();
        if (removed == 0) {
            throw AbvException.notFound("member not found");
        }
    }

    private void insertMember(UUID conversationId, UUID userId, MemberRole role, AbvException foreignKeyError) {
        try {
            jdbc.sql(INSERT_MEMBER)
                    .param(conversationId)
                    .param(userId)
                    .param(role.json())
                    .update();
        } catch (DataIntegrityViolationException e) {
            if (isForeignKeyViolation(e)) {
                throw foreignKeyError;
            }
            throw e;
        }
    }

    /**
     * Порядок выдачи сообщений: по created_at, затем по id.toString()
     * лексикографически (как sort.Slice в Go).
     */
    private static Comparator<Message> chronological() {
        return (left, right) -> {
            Instant leftAt = left.createdAt();
            Instant rightAt = right.createdAt();
            if (leftAt != null && rightAt != null) {
                int cmp = leftAt.compareTo(rightAt);
                if (cmp != 0) {
                    return cmp;
                }
            } else if (leftAt == null && rightAt != null) {
                return -1;
            } else if (leftAt != null) {
                return 1;
            }
            return left.id().toString().compareTo(right.id().toString());
        };
    }

    private static int limitOrDefault(int limit) {
        return limit <= 0 || limit > 100 ? 50 : limit;
    }

    // ------------------------------------------------------------- внутренние

    private record ConversationRow(Conversation conversation, int unread) {
    }

    private record MemberRow(UUID conversationId, User user) {
    }

    public record DirectOutcome(Conversation conversation, boolean created) {
    }

    public record Inserted(Message message, boolean created) {
    }

    public record MessagePage(List<Message> items, boolean hasMore) {
    }

    /**
     * Позиция в keyset-пагинации списка диалогов. Кодируется непрозрачной для
     * клиента строкой {@code <instant ISO>|<uuid>} (совместимо с Go-курсором
     * time.RFC3339Nano).
     */
    public record Cursor(Instant sortKey, UUID id) {

        public String encode() {
            return sortKey.toString() + "|" + id;
        }

        /** Пустая строка → null (первая страница); мусор → validation_failed. */
        public static Cursor parse(String raw) {
            String trimmed = raw == null ? "" : raw.strip();
            if (trimmed.isEmpty()) {
                return null;
            }
            int separator = trimmed.indexOf('|');
            if (separator < 0) {
                throw malformed();
            }
            Instant sortKey;
            try {
                sortKey = Instant.parse(trimmed.substring(0, separator).strip());
            } catch (DateTimeParseException e) {
                throw malformed();
            }
            UUID id;
            try {
                id = UUID.fromString(trimmed.substring(separator + 1).strip());
            } catch (RuntimeException e) {
                throw malformed();
            }
            return new Cursor(sortKey, id);
        }

        /** Курсор следующей страницы по последнему элементу текущей. */
        public static Cursor forView(ConversationView view) {
            Instant sortKey = view.conversation().lastMessageAt();
            return new Cursor(sortKey == null ? Instant.EPOCH : sortKey, view.conversation().id());
        }

        private static AbvException malformed() {
            return AbvException.invalidField("cursor", "cursor is malformed");
        }
    }
}
