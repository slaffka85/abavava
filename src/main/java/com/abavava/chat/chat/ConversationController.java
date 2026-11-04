package com.abavava.chat.chat;

import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.ConversationKind;
import com.abavava.chat.domain.ConversationView;
import com.abavava.chat.domain.Message;
import com.abavava.chat.http.CurrentUser;
import com.abavava.chat.http.JsonBody;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * HTTP-эндпоинты диалогов и сообщений (chat/handler.go в Go).
 *
 * <p>Коды ответов повторяют Go-реализацию: 201 только при реальном создании,
 * 200 для идемпотентного повтора, 204 для команд без тела.
 */
@RestController
@RequestMapping("/api/v1/conversations")
public class ConversationController {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final ChatService chat;
    private final ObjectMapper mapper;

    public ConversationController(ChatService chat, ObjectMapper mapper) {
        this.chat = chat;
        this.mapper = mapper;
    }

    public record CreateConversationRequest(
            @JsonProperty("kind") String kind,
            @JsonProperty("peer_id") UUID peerId,
            @JsonProperty("title") String title,
            @JsonProperty("member_ids") List<UUID> memberIds) {
    }

    public record SendMessageRequest(
            @JsonProperty("body") String body,
            @JsonProperty("client_id") String clientId) {
    }

    public record ReadRequest(
            @JsonProperty("message_id") UUID messageId) {
    }

    public record TypingRequest(
            @JsonProperty("state") String state) {
    }

    public record MembersRequest(
            @JsonProperty("user_ids") List<UUID> userIds) {
    }

    public record MessageResponse(
            @JsonProperty("message") Message message) {
    }

    public record MessagesResponse(
            @JsonProperty("items") List<Message> items,
            @JsonProperty("has_more") boolean hasMore) {
    }

    /** GET /conversations: items + next_cursor (null, если страниц больше нет). */
    @GetMapping
    public ResponseEntity<Map<String, Object>> list(HttpServletRequest request) {
        UUID actor = CurrentUser.userId(request);
        int limit = parseLimit(request.getParameter("limit"));
        ChatService.ListPage page = chat.list(actor, limit, request.getParameter("cursor"));

        // LinkedHashMap, а не Map.of: next_cursor обязан присутствовать как null.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("items", page.items());
        body.put("next_cursor", page.nextCursor() == null || page.nextCursor().isEmpty()
                ? null
                : page.nextCursor());
        return ResponseEntity.ok(body);
    }

    /** POST /conversations: direct (200/201) либо group (201). */
    @PostMapping
    public ResponseEntity<ConversationView> create(HttpServletRequest request) {
        UUID actor = CurrentUser.userId(request);
        CreateConversationRequest body = JsonBody.required(request, CreateConversationRequest.class, mapper);

        String kind = body.kind();
        if (kind == null || kind.isEmpty() || ConversationKind.DIRECT.json().equals(kind)) {
            if (body.peerId() == null) {
                throw AbvException.invalidField("peer_id", "peer_id is required for a direct conversation");
            }
            ChatCommands.DirectResult result = chat.ensureDirect(actor, body.peerId());
            // 200 — диалог уже существовал, это не создание.
            return ResponseEntity.status(result.created() ? 201 : 200).body(result.view());
        }
        if (ConversationKind.GROUP.json().equals(kind)) {
            List<UUID> memberIds = body.memberIds() == null ? List.of() : body.memberIds();
            return ResponseEntity.status(201).body(chat.createGroup(actor, body.title(), memberIds));
        }
        throw AbvException.invalidField("kind", "kind must be \"direct\" or \"group\"");
    }

    /** GET /conversations/{id}. */
    @GetMapping("/{id}")
    public ResponseEntity<ConversationView> get(HttpServletRequest request, @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        return ResponseEntity.ok(chat.get(actor, parseConversationId(rawId)));
    }

    /** GET /conversations/{id}/messages: keyset-пагинация назад по времени. */
    @GetMapping("/{id}/messages")
    public ResponseEntity<MessagesResponse> listMessages(HttpServletRequest request,
                                                         @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        int limit = parseLimit(request.getParameter("limit"));
        ChatService.MessagesPage page = chat.messages(actor, conversationId, limit, request.getParameter("before"));
        return ResponseEntity.ok(new MessagesResponse(page.items(), page.hasMore()));
    }

    /** POST /conversations/{id}/messages: 201 при создании, 200 при повторе client_id. */
    @PostMapping("/{id}/messages")
    public ResponseEntity<MessageResponse> sendMessage(HttpServletRequest request,
                                                      @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        SendMessageRequest body = JsonBody.required(request, SendMessageRequest.class, mapper);
        ChatCommands.SendResult result = chat.sendMessage(actor, conversationId, body.body(), body.clientId());
        return ResponseEntity.status(result.created() ? 201 : 200)
                .body(new MessageResponse(result.message()));
    }

    /** POST /conversations/{id}/read. */
    @PostMapping("/{id}/read")
    public ResponseEntity<Void> markRead(HttpServletRequest request, @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        ReadRequest body = JsonBody.required(request, ReadRequest.class, mapper);
        if (body.messageId() == null) {
            throw AbvException.invalidField("message_id", "message_id is required");
        }
        chat.markRead(actor, conversationId, body.messageId());
        return ResponseEntity.noContent().build();
    }

    /** POST /conversations/{id}/typing: REST-дубль WS-события typing. */
    @PostMapping("/{id}/typing")
    public ResponseEntity<Void> typing(HttpServletRequest request, @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        TypingRequest body = JsonBody.required(request, TypingRequest.class, mapper);
        chat.typing(actor, conversationId, body.state());
        return ResponseEntity.noContent().build();
    }

    /** POST /conversations/{id}/members (только группа, владелец). */
    @PostMapping("/{id}/members")
    public ResponseEntity<ConversationView> addMembers(HttpServletRequest request,
                                                      @PathVariable("id") String rawId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        MembersRequest body = JsonBody.required(request, MembersRequest.class, mapper);
        if (body.userIds() == null || body.userIds().isEmpty()) {
            throw AbvException.invalidField("user_ids", "user_ids must not be empty");
        }
        return ResponseEntity.ok(chat.addMembers(actor, conversationId, body.userIds()));
    }

    /** DELETE /conversations/{id}/members/{user_id}: владелец — любого, участник — себя. */
    @DeleteMapping("/{id}/members/{user_id}")
    public ResponseEntity<Void> removeMember(HttpServletRequest request,
                                            @PathVariable("id") String rawId,
                                            @PathVariable("user_id") String rawUserId) {
        UUID actor = CurrentUser.userId(request);
        UUID conversationId = parseConversationId(rawId);
        UUID target;
        try {
            target = UUID.fromString(rawUserId);
        } catch (RuntimeException e) {
            throw AbvException.invalidField("user_id", "user_id must be a valid uuid");
        }
        chat.removeMember(actor, conversationId, target);
        return ResponseEntity.noContent().build();
    }

    private static UUID parseConversationId(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (RuntimeException e) {
            throw AbvException.invalidField("id", "conversation id must be a valid uuid");
        }
    }

    /** limit из query: некорректное значение → значение по умолчанию, > 200 → 200. */
    private static int parseLimit(String raw) {
        if (raw == null || raw.isEmpty()) {
            return DEFAULT_LIMIT;
        }
        long value = 0;
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch < '0' || ch > '9') {
                return DEFAULT_LIMIT;
            }
            value = value * 10 + (ch - '0');
            if (value > MAX_LIMIT) {
                return MAX_LIMIT;
            }
        }
        return value <= 0 ? DEFAULT_LIMIT : (int) value;
    }
}
