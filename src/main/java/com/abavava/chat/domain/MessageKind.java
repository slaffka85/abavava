package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** text | system | call. */
public enum MessageKind {
    TEXT("text"),
    SYSTEM("system"),
    CALL("call");

    private final String json;

    MessageKind(String json) {
        this.json = json;
    }

    @JsonValue
    public String json() {
        return json;
    }

    @JsonCreator
    public static MessageKind fromJson(String raw) {
        for (MessageKind k : values()) {
            if (k.json.equalsIgnoreCase(raw)) {
                return k;
            }
        }
        throw new IllegalArgumentException("unknown message kind: " + raw);
    }
}
