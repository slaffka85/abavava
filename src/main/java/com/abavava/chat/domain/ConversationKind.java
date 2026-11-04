package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** direct | group. Значение в JSON и в БД — нижний регистр. */
public enum ConversationKind {
    DIRECT("direct"),
    GROUP("group");

    private final String json;

    ConversationKind(String json) {
        this.json = json;
    }

    @JsonValue
    public String json() {
        return json;
    }

    @JsonCreator
    public static ConversationKind fromJson(String raw) {
        for (ConversationKind k : values()) {
            if (k.json.equalsIgnoreCase(raw)) {
                return k;
            }
        }
        throw new IllegalArgumentException("unknown conversation kind: " + raw);
    }
}
