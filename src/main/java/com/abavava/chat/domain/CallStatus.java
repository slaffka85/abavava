package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Состояние звонка: ringing → accepted → ended; из ringing также rejected,
 * canceled, missed. Аналог domain.CallStatus в Go (см. docs/WS-PROTOCOL.md).
 */
public enum CallStatus {
    RINGING("ringing"),
    ACCEPTED("accepted"),
    REJECTED("rejected"),
    MISSED("missed"),
    ENDED("ended"),
    FAILED("failed"),
    CANCELED("canceled");

    private final String json;

    CallStatus(String json) {
        this.json = json;
    }

    @JsonValue
    public String json() {
        return json;
    }

    @JsonCreator
    public static CallStatus fromJson(String raw) {
        for (CallStatus s : values()) {
            if (s.json.equalsIgnoreCase(raw)) {
                return s;
            }
        }
        throw new IllegalArgumentException("unknown call status: " + raw);
    }

    public boolean active() {
        return this == RINGING || this == ACCEPTED;
    }

    public boolean terminal() {
        return !active();
    }
}
