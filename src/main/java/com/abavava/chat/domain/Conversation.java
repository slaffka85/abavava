package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.UUID;

/** Диалог (без участников и непрочитанных — они в ConversationView). */
public record Conversation(
        @JsonProperty("id") UUID id,
        @JsonProperty("kind") ConversationKind kind,
        @JsonProperty("title") String title,
        @JsonProperty("created_by") UUID createdBy,
        @JsonProperty("created_at") Instant createdAt,
        @JsonProperty("updated_at") Instant updatedAt,
        @JsonProperty("last_message_at") Instant lastMessageAt
) {
}
