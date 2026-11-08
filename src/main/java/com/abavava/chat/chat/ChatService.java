package com.abavava.chat.chat;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.Broadcaster;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.contract.NoopBroadcaster;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Conversation;
import com.abavava.chat.domain.ConversationKind;
import com.abavava.chat.domain.ConversationView;
import com.abavava.chat.domain.Events;
import com.abavava.chat.domain.MemberRole;
import com.abavava.chat.domain.Message;
import com.abavava.chat.domain.MessageKind;
import com.abavava.chat.push.FcmPushSender;
import com.abavava.chat.push.PushDeviceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Сценарии работы с диалогами и сообщениями (chat/service.go).
 *
 * <p>Все методы принимают идентификатор действующего пользователя и сами
 * проверяют права. Отсутствие доступа маскируется под 404: посторонний не
 * должен узнать, что диалог существует.
 *
 * <p>Broadcaster берётся лениво через {@link ObjectProvider}: realtime.Hub
 * зависит от ChatCommands, а ChatService — от Broadcaster, то есть между
 * бинами есть цикл, который разрешается только отложенным получением.
 */
@Service
public class ChatService implements ChatCommands {

    private static final Logger log = LoggerFactory.getLogger(ChatService.class);

    private final ChatRepository repo;
    private final PushDeviceRepository pushDevices;
    private final FcmPushSender pushSender;
    private final ObjectProvider<Broadcaster> broadcasters;
    /** Предел длины текста сообщения: abv.max-message-length. */
    private final int maxBodyLength;
    /** Предел участников группового диалога: abv.chat.max-group-members. */
    private final int maxGroupMembers;
    /** Длина заголовка группы (code points): abv.chat.max-title-length. */
    private final int maxTitleLength;

    public ChatService(ChatRepository repo, ObjectProvider<Broadcaster> broadcasters,
                       PushDeviceRepository pushDevices, FcmPushSender pushSender, AbvProperties props) {
        this.repo = repo;
        this.broadcasters = broadcasters;
        this.pushDevices = pushDevices;
        this.pushSender = pushSender;
        this.maxBodyLength = props.maxMessageLength();
        this.maxGroupMembers = props.chat().maxGroupMembers();
        this.maxTitleLength = props.chat().maxTitleLength();
    }

    /** Хранилище (нужно realtime-слою для рассылки присутствия). */
    public ChatRepository repository() {
        return repo;
    }

    // ------------------------------------------------------------ ChatCommands

    @Override
    public SendResult sendMessage(UUID actor, UUID conversationId, String body, String clientId) {
        requireMember(actor, conversationId);

        String trimmed = trimTrailingNewlines(body == null ? "" : body);
        if (isBlank(trimmed)) {
            throw AbvException.invalidField("body", "message body must not be empty");
        }
        if (trimmed.codePointCount(0, trimmed.length()) > maxBodyLength) {
            throw AbvException.invalidField("body",
                    "message body must be at most " + maxBodyLength + " characters");
        }

        ChatRepository.Inserted inserted = repo.insertMessage(
                conversationId, actor, MessageKind.TEXT, trimmed, clientId);
        if (!inserted.created()) {
            // Идемпотентный повтор: сообщение уже разослано ранее.
            return new SendResult(inserted.message(), false);
        }
        fanOutMessage(inserted.message());
        return new SendResult(inserted.message(), true);
    }

    @Override
    public void markRead(UUID actor, UUID conversationId, UUID messageId) {
        requireMember(actor, conversationId);
        Instant readAt = repo.markRead(conversationId, actor, messageId);
        List<UUID> members = repo.memberIds(conversationId);
        broadcaster().sendToUsers(members, Events.newEvent(Events.MESSAGE_READ,
                new Events.MessageReadPayload(conversationId, actor, messageId, readAt)));
    }

    @Override
    public void typing(UUID actor, UUID conversationId, String state) {
        if (!"start".equals(state) && !"stop".equals(state)) {
            throw AbvException.invalidField("state", "state must be \"start\" or \"stop\"");
        }
        requireMember(actor, conversationId);
        List<UUID> recipients = new ArrayList<>();
        for (UUID member : repo.memberIds(conversationId)) {
            if (!member.equals(actor)) {
                recipients.add(member);
            }
        }
        broadcaster().sendToUsers(recipients, Events.newEvent(Events.TYPING,
                new Events.TypingPayload(conversationId, actor, state)));
    }

    @Override
    public List<UUID> peersOf(UUID userId) {
        return repo.peersOf(userId);
    }

    @Override
    public List<UUID> memberIds(UUID conversationId) {
        return repo.memberIds(conversationId);
    }

    @Override
    public DirectResult ensureDirect(UUID actor, UUID peerId) {
        if (actor.equals(peerId)) {
            throw AbvException.invalid("cannot start a conversation with yourself");
        }
        ChatRepository.DirectOutcome outcome = repo.ensureDirect(actor, peerId);
        ConversationView view = repo.conversationView(outcome.conversation().id(), actor);
        return new DirectResult(view, outcome.created());
    }

    // ------------------------------------------------------------- REST-сценарии

    /** Создаёт групповой диалог: создатель становится владельцем. */
    public ConversationView createGroup(UUID actor, String title, List<UUID> memberIds) {
        String cleanTitle = collapseSpaces(title == null ? "" : title);
        if (cleanTitle.isEmpty()) {
            throw AbvException.invalidField("title", "title is required for a group conversation");
        }
        if (cleanTitle.codePointCount(0, cleanTitle.length()) > maxTitleLength) {
            throw AbvException.invalidField("title",
                    "title must be at most " + maxTitleLength + " characters");
        }

        // Участники: дедупликация с исключением самого создателя.
        Set<UUID> seen = new HashSet<>();
        seen.add(actor);
        List<UUID> unique = new ArrayList<>(memberIds.size());
        for (UUID memberId : memberIds) {
            if (memberId == null || !seen.add(memberId)) {
                continue;
            }
            unique.add(memberId);
        }
        if (unique.size() + 1 > maxGroupMembers) {
            throw AbvException.invalidField("member_ids",
                    "a group can have at most " + maxGroupMembers + " members");
        }

        Conversation conversation = repo.createGroup(actor, cleanTitle, unique);
        return repo.conversationView(conversation.id(), actor);
    }

    /** Страница диалогов пользователя: элементы + курсор следующей страницы ("" — нет). */
    public ListPage list(UUID actor, int limit, String cursorRaw) {
        ChatRepository.Cursor cursor = ChatRepository.Cursor.parse(cursorRaw);
        List<ConversationView> views = repo.listConversations(actor, limit, cursor);
        String next = "";
        if (views.size() == limitOrDefault(limit) && !views.isEmpty()) {
            next = ChatRepository.Cursor.forView(views.get(views.size() - 1)).encode();
        }
        return new ListPage(views, next);
    }

    /** Диалог, если пользователь — его участник. */
    public ConversationView get(UUID actor, UUID conversationId) {
        requireMember(actor, conversationId);
        return repo.conversationView(conversationId, actor);
    }

    /** Страница сообщений диалога (от старых к новым внутри страницы). */
    public MessagesPage messages(UUID actor, UUID conversationId, int limit, String beforeRaw) {
        requireMember(actor, conversationId);
        UUID before = null;
        String raw = beforeRaw == null ? "" : beforeRaw.strip();
        if (!raw.isEmpty()) {
            try {
                before = UUID.fromString(raw);
            } catch (RuntimeException e) {
                throw AbvException.invalidField("before", "before must be a valid message id");
            }
        }
        ChatRepository.MessagePage page = repo.messages(conversationId, limit, before);
        return new MessagesPage(page.items(), page.hasMore());
    }

    /** Добавляет участников в групповой диалог (только владелец). */
    public ConversationView addMembers(UUID actor, UUID conversationId, List<UUID> memberIds) {
        Conversation conversation = repo.conversationById(conversationId);
        if (conversation.kind() != ConversationKind.GROUP) {
            throw AbvException.invalid("only group conversations support member changes");
        }
        MemberRole role = requireMember(actor, conversationId);
        if (role != MemberRole.OWNER) {
            throw AbvException.forbidden("only the group owner can add members");
        }
        List<UUID> existing = repo.memberIds(conversationId);
        if (existing.size() + memberIds.size() > maxGroupMembers) {
            throw AbvException.invalid("group member limit exceeded");
        }
        repo.addMembers(conversationId, memberIds);
        return repo.conversationView(conversationId, actor);
    }

    /** Удаляет участника: владелец — любого, участник — только себя. */
    public void removeMember(UUID actor, UUID conversationId, UUID target) {
        MemberRole role = requireMember(actor, conversationId);
        if (!actor.equals(target) && role != MemberRole.OWNER) {
            throw AbvException.forbidden("only the group owner can remove other members");
        }
        repo.removeMember(conversationId, target);
    }

    // ------------------------------------------------------------------ helpers

    /** Проверка участия: нет строки → not_found("conversation not found"). */
    private MemberRole requireMember(UUID actor, UUID conversationId) {
        return repo.memberRole(conversationId, actor);
    }

    /**
     * Рассылает message.new всем участникам диалога. Ошибка загрузки состава
     * не должна ронять уже сохранённое сообщение — только пишем в лог.
     */
    private void fanOutMessage(Message message) {
        List<UUID> members;
        try {
            members = repo.memberIds(message.conversationId());
        } catch (RuntimeException e) {
            log.error("broadcast message: load members", e);
            return;
        }
        broadcaster().sendToUsers(members, Events.newEvent(Events.MESSAGE_NEW,
                new Events.MessageNewPayload(message)));
        if (pushSender.enabled()) {
            for (UUID member : members) {
                if (member.equals(message.senderId())) continue;
                for (String token : pushDevices.tokens(member)) {
                    try {
                        pushSender.sendNewMessage(token);
                    } catch (RuntimeException e) {
                        log.warn("message push failed: conversation_id={} recipient_id={}",
                                message.conversationId(), member, e);
                    }
                }
            }
        }
    }

    private Broadcaster broadcaster() {
        return broadcasters.getIfAvailable(() -> NoopBroadcaster.INSTANCE);
    }

    private static int limitOrDefault(int limit) {
        return limit <= 0 || limit > 100 ? 50 : limit;
    }

    /** Аналог strings.TrimRight(body, "\n"): срезает только хвостовые переводы строк. */
    private static String trimTrailingNewlines(String body) {
        int end = body.length();
        while (end > 0 && body.charAt(end - 1) == '\n') {
            end--;
        }
        return body.substring(0, end);
    }

    /**
     * Аналог strings.TrimSpace(s) == "": пустая строка либо только пробельные
     * code points в терминах unicode.IsSpace (включая NBSP и NEL, которые
     * Character.isWhitespace не считает пробелом).
     */
    private static boolean isBlank(String value) {
        for (int i = 0; i < value.length(); ) {
            int codePoint = value.codePointAt(i);
            if (!isSpace(codePoint)) {
                return false;
            }
            i += Character.charCount(codePoint);
        }
        return true;
    }

    /** Аналог strings.Join(strings.Fields(s), " "). */
    private static String collapseSpaces(String value) {
        StringBuilder out = new StringBuilder(value.length());
        boolean pending = false;
        for (int i = 0; i < value.length(); ) {
            int codePoint = value.codePointAt(i);
            i += Character.charCount(codePoint);
            if (isSpace(codePoint)) {
                pending = out.length() > 0;
                continue;
            }
            if (pending) {
                out.append(' ');
                pending = false;
            }
            out.appendCodePoint(codePoint);
        }
        return out.toString();
    }

    /** unicode.IsSpace из Go: \t \n \v \f \r ' ' NEL NBSP и категории Z (Zs/Zl/Zp). */
    private static boolean isSpace(int codePoint) {
        return switch (codePoint) {
            case '\t', '\n', '\u000B', '\f', '\r', ' ', '\u0085', '\u00A0' -> true;
            default -> {
                int category = Character.getType(codePoint);
                yield category == Character.SPACE_SEPARATOR
                        || category == Character.LINE_SEPARATOR
                        || category == Character.PARAGRAPH_SEPARATOR;
            }
        };
    }

    /** Личный диалог (createGroup/ensureDirect возвращают это же представление). */
    public record ListPage(List<ConversationView> items, String nextCursor) {
    }

    public record MessagesPage(List<Message> items, boolean hasMore) {
    }
}
