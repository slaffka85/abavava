package com.abavava.chat.security;

import com.abavava.chat.domain.AbvException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JwtServiceTest {

    private static final String SECRET = "test-secret-for-jwt-unit-tests-0123456789";

    private JwtService service(Duration ttl) {
        return new JwtService(SECRET, ttl, JsonMapper.builder().build());
    }

    @Test
    void issueAndVerifyRoundTrip() {
        UUID userId = UUID.randomUUID();
        String token = service(Duration.ofMinutes(15)).issueAccessToken(userId);
        assertThat(token.split("\\.")).hasSize(3);
        assertThat(service(Duration.ofMinutes(15)).verifyAccessToken(token)).isEqualTo(userId);
    }

    @Test
    void tamperedSignatureIsRejected() {
        String token = service(Duration.ofMinutes(15)).issueAccessToken(UUID.randomUUID());
        String tampered = token.substring(0, token.length() - 2) + "aa";
        assertThatThrownBy(() -> service(Duration.ofMinutes(15)).verifyAccessToken(tampered))
                .isInstanceOf(AbvException.class)
                .satisfies(e -> assertThat(((AbvException) e).code()).isEqualTo(AbvException.Code.UNAUTHORIZED));
    }

    @Test
    void wrongSecretIsRejected() {
        String token = service(Duration.ofMinutes(15)).issueAccessToken(UUID.randomUUID());
        JwtService other = new JwtService("another-secret-with-different-value-123456", Duration.ofMinutes(15),
                JsonMapper.builder().build());
        assertThatThrownBy(() -> other.verifyAccessToken(token)).isInstanceOf(AbvException.class);
    }

    @Test
    void expiredTokenIsRejected() {
        String token = service(Duration.ofSeconds(-1)).issueAccessToken(UUID.randomUUID());
        assertThatThrownBy(() -> service(Duration.ofMinutes(15)).verifyAccessToken(token))
                .isInstanceOf(AbvException.class);
    }

    @Test
    void garbageTokenIsRejected() {
        assertThatThrownBy(() -> service(Duration.ofMinutes(15)).verifyAccessToken("not-a-token"))
                .isInstanceOf(AbvException.class);
    }
}
