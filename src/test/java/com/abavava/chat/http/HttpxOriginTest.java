package com.abavava.chat.http;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class HttpxOriginTest {

    private static final List<String> ALLOWED = List.of("http://localhost:5173", "https://*.example.com");

    @Test
    void emptyOriginIsTrusted() {
        assertThat(Httpx.originAllowed(null, "localhost:8080", ALLOWED)).isTrue();
        assertThat(Httpx.originAllowed("", "localhost:8080", ALLOWED)).isTrue();
    }

    @Test
    void exactOriginIsAllowed() {
        assertThat(Httpx.originAllowed("http://localhost:5173", "api.local:8080", ALLOWED)).isTrue();
    }

    @Test
    void sameHostIsAllowedRegardlessOfPortAndScheme() {
        assertThat(Httpx.originAllowed("http://192.168.1.222:8081", "192.168.1.222:8080", ALLOWED)).isTrue();
    }

    @Test
    void subdomainWildcardIsAllowed() {
        assertThat(Httpx.originAllowed("https://app.example.com", "api.local:8080", ALLOWED)).isTrue();
    }

    @Test
    void foreignOriginIsRejected() {
        assertThat(Httpx.originAllowed("http://evil.example.net", "192.168.1.222:8080", ALLOWED)).isFalse();
        assertThat(Httpx.originAllowed("http://evil-example.com", "example.com", ALLOWED)).isFalse();
    }

    @Test
    void hostOnlyStripsPort() {
        assertThat(Httpx.hostOnly("192.168.1.222:8081")).isEqualTo("192.168.1.222");
        assertThat(Httpx.hostOnly("[::1]:8080")).isEqualTo("::1");
    }
}
