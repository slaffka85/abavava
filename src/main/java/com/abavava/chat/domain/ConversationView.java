package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/** То, что получает клиент: диалог, участники, последнее сообщение, непрочитанные. */
public record ConversationView(
        @JsonProperty("conversation") Conversation conversation,
        @JsonProperty("members") List<User> members,
        @JsonProperty("last_message") Message lastMessage,
        @JsonProperty("unread_count") int unreadCount
) {
}
