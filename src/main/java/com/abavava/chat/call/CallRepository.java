package com.abavava.chat.call;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Call;
import com.abavava.chat.domain.CallKind;
import com.abavava.chat.domain.CallStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * Доступ к таблицам calls и call_events. SQL повторяет call/repo.go: набор
 * колонок, порядок сортировки истории, атомарный переход состояния и
 * «примиритель» зависших звонков.
 *
 * <p>Все параметры — позиционные ({@code ?}). Nullable-значения передаются с
 * явным приведением типа ({@code ?::uuid}, {@code ?::text}), потому что
 * PostgreSQL не может вывести тип пустого параметра из контекста CASE.
 */
@Repository
public class CallRepository {

    private static final Logger log = LoggerFactory.getLogger(CallRepository.class);

    static final String CALL_COLUMNS = "id, conversation_id, caller_id, callee_id, kind, status, "
            + "created_at, answered_at, ended_at, ended_by, end_reason, duration_seconds";

    private static final RowMapper<Call> MAPPER = (rs, rowNum) -> mapCall(rs);

    /**
     * Переход состояния: обновление проходит, только если текущий статус
     * по-прежнему равен ожидаемому ({@code WHERE ... AND status = ?}).
     * Параллельные accept/reject/end поэтому не дают гонок: второй запрос
     * обновит 0 строк и превратится в conflict.
     */
    private static final String TRANSITION_SQL = """
            UPDATE calls
               SET status           = ?,
                   answered_at      = CASE WHEN ?::text = 'accepted' THEN now() ELSE answered_at END,
                   ended_at         = CASE WHEN ?::text IN ('rejected', 'missed', 'ended', 'failed', 'canceled')
                                           THEN now() ELSE ended_at END,
                   ended_by         = CASE WHEN ?::text IN ('rejected', 'missed', 'ended', 'failed', 'canceled')
                                           THEN ?::uuid ELSE ended_by END,
                   end_reason       = CASE WHEN ?::text IN ('rejected', 'missed', 'ended', 'failed', 'canceled')
                                           THEN NULLIF(?::text, '') ELSE end_reason END,
                   duration_seconds = CASE WHEN ?::text IN ('ended', 'canceled')
                                           THEN GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (now() - answered_at))::int, 0))
                                           ELSE duration_seconds END
             WHERE id = ?
               AND status = ?::text
            RETURNING""" + " " + CALL_COLUMNS;

    private final JdbcClient jdbc;
    private final ObjectMapper mapper;

    public CallRepository(JdbcClient jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** Параметры создания записи звонка (Go: CreateCallInput). */
    public record CreateCallInput(UUID conversationId, UUID callerId, UUID calleeId, CallKind kind) {
    }

    /**
     * Описание перехода состояния (Go: TransitionInput).
     * {@code actorId == null} — системный переход (таймаут дозвона).
     */
    public record TransitionInput(UUID callId, CallStatus from, CallStatus to, UUID actorId, String endReason) {
    }

    /**
     * Создаёт звонок в статусе ringing. Частичные уникальные индексы
     * calls_one_active_as_* не дают завести второй активный звонок участнику.
     */
    public Call create(CreateCallInput in) {
        try {
            return jdbc.sql("INSERT INTO calls (conversation_id, caller_id, callee_id, kind, status)"
                            + " VALUES (?::uuid, ?, ?, ?, 'ringing') RETURNING " + CALL_COLUMNS)
                    .param(in.conversationId())
                    .param(in.callerId())
                    .param(in.calleeId())
                    .param(in.kind().json())
                    .query(MAPPER)
                    .single();
        } catch (DuplicateKeyException e) {
            throw AbvException.conflict("one of the participants is already in a call");
        } catch (DataIntegrityViolationException e) {
            throw AbvException.notFound("user or conversation not found");
        }
    }

    /** Звонок по id; нет такого → 404 not_found. */
    public Call byId(UUID id) {
        return jdbc.sql("SELECT " + CALL_COLUMNS + " FROM calls WHERE id = ?")
                .param(id)
                .query(MAPPER)
                .optional()
                .orElseThrow(() -> AbvException.notFound("call not found"));
    }

    /** Активный звонок пользователя в любой роли (ringing | accepted) либо null. */
    public Call activeForUser(UUID userId) {
        return jdbc.sql("SELECT " + CALL_COLUMNS + " FROM calls"
                        + " WHERE status IN ('ringing', 'accepted')"
                        + " AND (caller_id = ? OR callee_id = ?)"
                        + " ORDER BY created_at DESC LIMIT 1")
                .param(userId)
                .param(userId)
                .query(MAPPER)
                .optional()
                .orElse(null);
    }

    /** История звонков пользователя (новые сверху); limit вне (0, 200] → 50. */
    public List<Call> history(UUID userId, int limit) {
        int capped = limit <= 0 || limit > 200 ? 50 : limit;
        return jdbc.sql("SELECT " + CALL_COLUMNS + " FROM calls"
                        + " WHERE caller_id = ? OR callee_id = ?"
                        + " ORDER BY created_at DESC LIMIT ?")
                .param(userId)
                .param(userId)
                .param(capped)
                .query(MAPPER)
                .list();
    }

    /**
     * Атомарный переход состояния. Пустой RETURNING означает одно из двух:
     * звонка нет (→ not_found) либо статус уже сменил другой участник
     * (→ conflict).
     */
    public Call transition(TransitionInput in) {
        String to = in.to().json();
        String endReason = in.endReason() == null ? "" : in.endReason();
        Optional<Call> updated = jdbc.sql(TRANSITION_SQL)
                .param(to)
                .param(to)
                .param(to)
                .param(to)
                .param(in.actorId())
                .param(to)
                .param(endReason)
                .param(to)
                .param(in.callId())
                .param(in.from().json())
                .query(MAPPER)
                .optional();
        if (updated.isPresent()) {
            return updated.get();
        }
        Call current = byId(in.callId());
        throw AbvException.conflict("call is already %s", current.status().json());
    }

    /**
     * Закрывает «зависшие» звонки: после перезапуска сервиса таймеры дозвона
     * потеряны, поэтому ringing старше timeout (abv.call-ring-timeout) помечается
     * missed.
     *
     * @return количество закрытых звонков
     */
    public long reconcileMissed(Duration timeout) {
        Objects.requireNonNull(timeout, "timeout");
        return jdbc.sql("""
                        UPDATE calls
                           SET status = 'missed', ended_at = now(), end_reason = 'timeout'
                         WHERE status = 'ringing'
                           AND created_at < now() - ((?::text || ' milliseconds')::interval)""")
                .param(Long.toString(timeout.toMillis()))
                .update();
    }

    /**
     * Журнал событий звонка. Вторичен: ошибка записи логируется и не роняет
     * обработку звонка (как в Go LogEvent).
     */
    public void logEvent(UUID callId, UUID actorId, String type, Map<String, Object> payload) {
        String json = null;
        if (payload != null && !payload.isEmpty()) {
            try {
                json = mapper.writeValueAsString(payload);
            } catch (RuntimeException e) {
                log.warn("serialize call event payload: call_id={} type={}", callId, type, e);
                return;
            }
        }
        try {
            jdbc.sql("INSERT INTO call_events (call_id, actor_id, type, payload)"
                            + " VALUES (?, ?::uuid, ?, ?::jsonb)")
                    .param(callId)
                    .param(actorId)
                    .param(type)
                    .param(json)
                    .update();
        } catch (RuntimeException e) {
            log.warn("log call event: call_id={} type={}", callId, type, e);
        }
    }

    static Call mapCall(ResultSet rs) throws SQLException {
        return new Call(
                rs.getObject("id", UUID.class),
                rs.getObject("conversation_id", UUID.class),
                rs.getObject("caller_id", UUID.class),
                rs.getObject("callee_id", UUID.class),
                CallKind.fromJson(rs.getString("kind")),
                CallStatus.fromJson(rs.getString("status")),
                instant(rs, "created_at"),
                instant(rs, "answered_at"),
                instant(rs, "ended_at"),
                rs.getObject("ended_by", UUID.class),
                rs.getString("end_reason"),
                rs.getInt("duration_seconds"),
                null);
    }

    static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }
}
