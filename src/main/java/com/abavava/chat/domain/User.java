package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonValue;

import java.time.Instant;
import java.util.UUID;

/** Профиль пользователя. JSON-контракт совпадает с domain.User в Go. */
public record User(
        @JsonProperty("id") UUID id,
        @JsonProperty("email") String email,
        @JsonProperty("display_name") String displayName,
        @JsonProperty("avatar_url") String avatarUrl,
        @JsonProperty("created_at") Instant createdAt,
        @JsonProperty("last_seen_at") Instant lastSeenAt
) {
}
