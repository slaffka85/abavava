package com.abavava.chat.push;

import com.abavava.chat.domain.Call;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/** Sends high priority FCM HTTP v1 data messages using a service-account key. */
@Service
public class FcmPushSender {
    private static final Logger log = LoggerFactory.getLogger(FcmPushSender.class);
    private static final String TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    private static final String SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
    private final String credentialsFile;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(8)).build();

    public FcmPushSender(@Value("${abv.fcm.service-account-file:}") String credentialsFile, ObjectMapper mapper) {
        this.credentialsFile = credentialsFile == null ? "" : credentialsFile.trim();
        this.mapper = mapper;
    }

    public boolean enabled() {
        return !credentialsFile.isBlank() && Files.isRegularFile(Path.of(credentialsFile));
    }

    @SuppressWarnings("unchecked")
    public void sendIncomingCall(String token, Call call, String caller) {
        sendData(token, Map.of("type", "incoming_call", "call_id", call.id().toString(),
                "caller", caller, "kind", call.kind().json()));
    }

    /** Generic message notification: do not send private message text to FCM. */
    public void sendNewMessage(String token) {
        sendData(token, Map.of("type", "new_message"));
    }

    @SuppressWarnings("unchecked")
    private void sendData(String token, Map<String,String> data) {
        try {
            Map<String,Object> account = mapper.readValue(Files.readString(Path.of(credentialsFile)), Map.class);
            String projectId = String.valueOf(account.get("project_id"));
            String accessToken = accessToken(String.valueOf(account.get("client_email")),
                    String.valueOf(account.get("private_key")), String.valueOf(account.getOrDefault("token_uri", TOKEN_ENDPOINT)));
            Map<String,Object> message = Map.of("token", token, "data", data,
                    "android", Map.of("priority", "high"));
            String payload = mapper.writeValueAsString(Map.of("message", message));
            String endpoint = "https://fcm.googleapis.com/v1/projects/" + URLEncoder.encode(projectId, StandardCharsets.UTF_8) + "/messages:send";
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint)).timeout(java.time.Duration.ofSeconds(10))
                    .header("Authorization", "Bearer " + accessToken).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload)).build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300)
                throw new IllegalStateException("FCM returned HTTP " + response.statusCode() + ": " + response.body());
        } catch (Exception e) {
            throw new IllegalStateException("send FCM incoming call", e);
        }
    }

    @SuppressWarnings("unchecked")
    private String accessToken(String email, String privateKeyPem, String tokenUri) throws Exception {
        long now = Instant.now().getEpochSecond();
        String header = base64(mapper.writeValueAsString(Map.of("alg", "RS256", "typ", "JWT")));
        String claims = base64(mapper.writeValueAsString(Map.of("iss", email, "scope", SCOPE,
                "aud", tokenUri, "iat", now, "exp", now + 3600)));
        String unsigned = header + "." + claims;
        String keyBody = privateKeyPem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "").replaceAll("\\s", "");
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(keyBody)));
        Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(key);
        signer.update(unsigned.getBytes(StandardCharsets.US_ASCII));
        String assertion = unsigned + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
        String form = "grant_type=" + URLEncoder.encode("urn:ietf:params:oauth:grant-type:jwt-bearer", StandardCharsets.UTF_8)
                + "&assertion=" + URLEncoder.encode(assertion, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(URI.create(tokenUri)).timeout(java.time.Duration.ofSeconds(10))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300)
            throw new IllegalStateException("Google OAuth returned HTTP " + response.statusCode());
        Map<String,Object> result = mapper.readValue(response.body(), Map.class);
        return String.valueOf(result.get("access_token"));
    }
    private static String base64(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
