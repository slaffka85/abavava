package com.abavava.chat.domain;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** owner | member. */
public enum MemberRole {
    OWNER("owner"),
    MEMBER("member");

    private final String json;

    MemberRole(String json) {
        this.json = json;
    }

    @JsonValue
    public String json() {
        return json;
    }

    @JsonCreator
    public static MemberRole fromJson(String raw) {
        for (MemberRole r : values()) {
            if (r.json.equalsIgnoreCase(raw)) {
                return r;
            }
        }
        throw new IllegalArgumentException("unknown member role: " + raw);
    }
}
