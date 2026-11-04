package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.UUID;

/** Сообщение. JSON-контракт совпадает с domain.Message в Go. */
public record Message(
        @JsonProperty("id") UUID id,
        @JsonProperty("conversation_id") UUID conversationId,
        @JsonProperty("sender_id") UUID senderId,
        @JsonProperty("kind") MessageKind kind,
        @JsonProperty("body") String body,
        @JsonProperty("client_id") String clientId,
        @JsonProperty("created_at") Instant createdAt,
        @JsonProperty("edited_at") Instant editedAt,
        @JsonProperty("deleted_at") Instant deletedAt
) {
}
