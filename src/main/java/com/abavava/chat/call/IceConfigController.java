package com.abavava.chat.call;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.http.CurrentUser;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;

/**
 * GET /api/v1/config/ice — конфигурация ICE для RTCPeerConnection.
 * STUN отдаётся всегда, TURN — только если задан abv.turn-url; пустые
 * username/credential в JSON не попадают (omitempty в Go-реализации).
 */
@RestController
@RequestMapping("/api/v1")
public class IceConfigController {

    /** Один ICE-сервер (Go: ICEServer). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record IceServer(
            @JsonProperty("urls") List<String> urls,
            @JsonProperty("username") String username,
            @JsonProperty("credential") String credential) {
    }

    /** Ответ GET /config/ice (Go: ICEResponse). */
    public record IceResponse(
            @JsonProperty("ice_servers") List<IceServer> iceServers) {
    }

    private final AbvProperties properties;

    public IceConfigController(AbvProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/config/ice")
    public ResponseEntity<IceResponse> ice(HttpServletRequest request) {
        CurrentUser.userId(request);

        List<IceServer> servers = new ArrayList<>(2);
        List<String> stunUrls = properties.stunUrlList();
        if (!stunUrls.isEmpty()) {
            servers.add(new IceServer(stunUrls, null, null));
        }
        String turnUrl = properties.turnUrl() == null ? "" : properties.turnUrl();
        if (!turnUrl.isEmpty()) {
            servers.add(new IceServer(List.of(turnUrl),
                    emptyToNull(properties.turnUsername()),
                    emptyToNull(properties.turnCredential())));
        }
        return ResponseEntity.ok(new IceResponse(servers));
    }

    private static String emptyToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }
}
