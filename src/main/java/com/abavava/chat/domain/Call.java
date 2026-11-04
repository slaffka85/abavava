package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.UUID;

/**
 * Звонок. peer — собеседник относительно запросившего (omitempty, как в Go:
 * поле не попадает в JSON, если собеседник неизвестен).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Call(
        @JsonProperty("id") UUID id,
        @JsonProperty("conversation_id") UUID conversationId,
        @JsonProperty("caller_id") UUID callerId,
        @JsonProperty("callee_id") UUID calleeId,
        @JsonProperty("kind") CallKind kind,
        @JsonProperty("status") CallStatus status,
        @JsonProperty("created_at") Instant createdAt,
        @JsonProperty("answered_at") Instant answeredAt,
        @JsonProperty("ended_at") Instant endedAt,
        @JsonProperty("ended_by") UUID endedBy,
        @JsonProperty("end_reason") String endReason,
        @JsonProperty("duration_seconds") int durationSeconds,
        @JsonProperty("peer") User peer
) {

    public Call withPeer(User other) {
        return new Call(id, conversationId, callerId, calleeId, kind, status, createdAt,
                answeredAt, endedAt, endedBy, endReason, durationSeconds, other);
    }

    public UUID party(UUID userId) {
        return callerId.equals(userId) ? calleeId : callerId;
    }

    public boolean involved(UUID userId) {
        return callerId.equals(userId) || calleeId.equals(userId);
    }
}
