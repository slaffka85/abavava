package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** audio | video. */
public enum CallKind {
    AUDIO("audio"),
    VIDEO("video");

    private final String json;

    CallKind(String json) {
        this.json = json;
    }

    @JsonValue
    public String json() {
        return json;
    }

    @JsonCreator
    public static CallKind fromJson(String raw) {
        for (CallKind k : values()) {
            if (k.json.equalsIgnoreCase(raw)) {
                return k;
            }
        }
        throw new IllegalArgumentException("unknown call kind: " + raw);
    }
}
