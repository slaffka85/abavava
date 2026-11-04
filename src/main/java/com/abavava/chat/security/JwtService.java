package com.abavava.chat.security;

import com.abavava.chat.domain.AbvException;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Access-токен: JWT HS256, 15 минут, поля — как в Go-реализации
 * (internal/auth/tokens.go): iss=chat-abavava, sub=uuid, typ=access,
 * iat/nbf/exp, jti. Сознательно без внешних библиотек — контракт проверяется
 * тестами на совместимость токенов обоих бэкендов.
 */
public final class JwtService {

    private static final String ISSUER = "chat-abavava";
    private static final String TYPE_ACCESS = "access";
    private static final String ALG = "HS256";
    private static final byte[] HEADER =
            "{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8);
    private static final Base64.Encoder B64E = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder B64D = Base64.getUrlDecoder();
    private static final long NBF_SKEW_SECONDS = 30;

    private final byte[] secret;
    private final Duration accessTtl;
    private final ObjectMapper mapper;

    public JwtService(String secret, Duration accessTtl, ObjectMapper mapper) {
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 16) {
            throw new IllegalStateException("ABV_JWT_SECRET is too short (min 16 characters)");
        }
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.accessTtl = accessTtl;
        this.mapper = mapper;
    }

    /** Подписывает access-токен. */
    public String issueAccessToken(UUID userId) {
        Instant now = Instant.now();
        Map<String, Object> claims = new LinkedHashMap<>();
        claims.put("iss", ISSUER);
        claims.put("sub", userId.toString());
        claims.put("jti", UUID.randomUUID().toString());
        claims.put("iat", now.getEpochSecond());
        claims.put("nbf", now.getEpochSecond() - NBF_SKEW_SECONDS);
        claims.put("exp", now.getEpochSecond() + accessTtl.getSeconds());
        claims.put("typ", TYPE_ACCESS);
        String payload;
        try {
            payload = B64E.encodeToString(mapper.writeValueAsBytes(claims));
        } catch (RuntimeException e) {
            throw AbvException.internal(e);
        }
        String signingInput = B64E.encodeToString(HEADER) + "." + payload;
        String signature = B64E.encodeToString(mac(signingInput));
        return signingInput + "." + signature;
    }

    /** Проверяет подпись/алгоритм/издателя/срок/тип и возвращает id пользователя. */
    public UUID verifyAccessToken(String raw) {
        if (raw == null || raw.isBlank()) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        String[] parts = raw.split("\\.", -1);
        if (parts.length != 3) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        Map<String, Object> header;
        Map<String, Object> claims;
        try {
            header = mapper.readValue(B64D.decode(parts[0]), Map.class);
            claims = mapper.readValue(B64D.decode(parts[1]), Map.class);
        } catch (RuntimeException e) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        if (!ALG.equals(header.get("alg"))) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        byte[] expected = mac(parts[0] + "." + parts[1]);
        byte[] actual = B64D.decode(parts[2]);
        if (!MessageDigest.isEqual(expected, actual)) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        if (!ISSUER.equals(claims.get("iss"))) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        if (!TYPE_ACCESS.equals(claims.get("typ"))) {
            throw AbvException.unauthorized("invalid token type");
        }
        Object expRaw = claims.get("exp");
        if (!(expRaw instanceof Number exp)) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        Instant now = Instant.now();
        if (now.getEpochSecond() >= exp.longValue()) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        if (claims.get("nbf") instanceof Number nbf && now.getEpochSecond() < nbf.longValue() - NBF_SKEW_SECONDS) {
            throw AbvException.unauthorized("invalid or expired token");
        }
        Object sub = claims.get("sub");
        if (sub == null) {
            throw AbvException.unauthorized("invalid token subject");
        }
        try {
            return UUID.fromString(sub.toString());
        } catch (IllegalArgumentException e) {
            throw AbvException.unauthorized("invalid token subject");
        }
    }

    private byte[] mac(String signingInput) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw AbvException.internal(e);
        }
    }
}
