package com.abavava.chat.security;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PasswordsTest {

    @Test
    void hashMatchesPassword() {
        String hash = Passwords.hash("secret123");
        assertThat(hash).startsWith("$2a$12$");
        assertThat(Passwords.matches(hash, "secret123")).isTrue();
        assertThat(Passwords.matches(hash, "wrong")).isFalse();
    }

    @Test
    void rejectsPasswordLongerThan72Bytes() {
        String tooLong = "a".repeat(73);
        assertThatThrownBy(() -> Passwords.hash(tooLong)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void tokenHashingIsDeterministic() {
        String token = "some-refresh-token";
        assertThat(Passwords.hashToken(token)).isEqualTo(Passwords.hashToken(token)).hasSize(64);
        assertThat(Passwords.hashToken(token)).isNotEqualTo(Passwords.hashToken(token + "x"));
    }

    @Test
    void randomTokenIsUrlSafeAndRandom() {
        String a = Passwords.randomToken(32);
        String b = Passwords.randomToken(32);
        assertThat(a).isNotEqualTo(b).doesNotContain("=", "+", "/");
    }
}
