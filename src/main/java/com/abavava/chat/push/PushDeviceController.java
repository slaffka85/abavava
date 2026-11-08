package com.abavava.chat.push;

import com.abavava.chat.domain.AbvException;
import com.abavava.chat.http.CurrentUser;
import com.abavava.chat.http.JsonBody;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/v1/push/devices")
public class PushDeviceController {
    public record DeviceRequest(@JsonProperty("token") String token) {}
    private final PushDeviceRepository devices;
    private final ObjectMapper mapper;
    public PushDeviceController(PushDeviceRepository devices, ObjectMapper mapper) {
        this.devices = devices; this.mapper = mapper;
    }
    @PostMapping
    public ResponseEntity<Void> register(HttpServletRequest request) {
        var body = JsonBody.required(request, DeviceRequest.class, mapper);
        String token = body.token() == null ? "" : body.token().trim();
        if (token.length() < 20 || token.length() > 4096) throw AbvException.invalidField("token", "invalid device token");
        devices.register(CurrentUser.userId(request), token);
        return ResponseEntity.noContent().build();
    }
    @DeleteMapping
    public ResponseEntity<Void> remove(HttpServletRequest request) {
        var body = JsonBody.required(request, DeviceRequest.class, mapper);
        if (body.token() == null || body.token().isBlank()) throw AbvException.invalidField("token", "token is required");
        devices.remove(CurrentUser.userId(request), body.token().trim());
        return ResponseEntity.noContent().build();
    }
}
