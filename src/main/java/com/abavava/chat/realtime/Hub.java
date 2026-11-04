package com.abavava.chat.realtime;

import com.abavava.chat.contract.Broadcaster;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.contract.RealtimeStats;
import com.abavava.chat.contract.UserLookup;
import com.abavava.chat.domain.Events;
import com.abavava.chat.domain.User;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Реестр активных WebSocket-соединений: доставка событий, присутствие и
 * диагностика. Аналог internal/realtime/hub.go.
 *
 * <p>Хаб живёт в памяти одного процесса. Для горизонтального масштабирования
 * {@link #sendToUsers(Collection, Events.Envelope)} достаточно заменить публикацией
 * в Redis Pub/Sub: интерфейс {@link Broadcaster} изолирует эту деталь от
 * бизнес-логики chat/call.
 *
 * <p>События присутствия рассылаются только собеседникам пользователя
 * ({@link ChatCommands#peersOf(UUID)}), а не ему самому: собственный статус клиент
 * знает и без сервера.
 */
@Service
public class Hub implements Broadcaster, RealtimeStats {

    private static final Logger log = LoggerFactory.getLogger(Hub.class);

    /**
     * Соединения по пользователям. Пустой набор удаляется из карты, поэтому
     * размер карты равен числу онлайн-пользователей.
     * <p>Структурные изменения (добавление/удаление набора, «первое»/«последнее»
     * соединение) выполняются под {@code synchronized (clients)}: без этого
     * проверка «первое соединение» и удаление пустого набора не атомарны.
     */
    private final ConcurrentHashMap<UUID, Set<WsClient>> clients = new ConcurrentHashMap<>();

    private final ObjectProvider<ChatCommands> chat;
    private final UserLookup userLookup;

    /**
     * Выставляется {@link #closeAll(String)}: во время остановки сервиса события
     * присутствия уже не рассылаются — БД может быть закрыта раньше соединений.
     */
    private volatile boolean shuttingDown;

    public Hub(ObjectProvider<ChatCommands> chat, UserLookup userLookup) {
        this.chat = chat;
        this.userLookup = userLookup;
    }

    /**
     * Добавляет соединение и объявляет пользователя онлайн собеседникам —
     * только при первом соединении (мультидевайс не должен спамить presence).
     */
    public void register(WsClient client) {
        if (client == null) {
            return;
        }
        UUID userId = client.userId();
        boolean first;
        synchronized (clients) {
            Set<WsClient> connections = clients.computeIfAbsent(userId, id -> ConcurrentHashMap.newKeySet());
            first = connections.isEmpty();
            connections.add(client);
        }
        if (first) {
            broadcastPresence(userId, "online");
            // Снимок присутствия онлайн-собеседников для только что
            // подключившегося: если собеседник был онлайн до нас, его
            // собственное "online" уже разослано (и мы его пропустили).
            sendPeersOnlineToUser(userId);
        }
    }

    /**
     * Удаляет соединение; если оно было последним — фиксирует last_seen_at и
     * объявляет пользователя offline собеседникам.
     * <p>Метод идемпотентен: повторный вызов (после записи и после закрытия
     * контейнером) не порождает второго presence.
     */
    public void unregister(WsClient client) {
        if (client == null) {
            return;
        }
        UUID userId = client.userId();
        boolean last = false;
        synchronized (clients) {
            Set<WsClient> connections = clients.get(userId);
            if (connections != null && connections.remove(client) && connections.isEmpty()) {
                clients.remove(userId);
                last = true;
            }
        }
        if (!last || shuttingDown) {
            return;
        }
        try {
            userLookup.touchLastSeen(userId);
        } catch (RuntimeException e) {
            log.warn("touch last seen on disconnect failed: user_id={} reason={}", userId, e.toString());
        }
        broadcastPresence(userId, "offline");
    }

    /**
     * Доставляет событие всем соединениям перечисленных пользователей.
     * Медленные клиенты закрываются, чтобы очередь не блокировала рассылку
     * остальным (как в Go-реализации).
     */
    @Override
    public void sendToUsers(Collection<UUID> userIds, Events.Envelope event) {
        if (userIds == null || userIds.isEmpty() || event == null) {
            return;
        }
        List<WsClient> targets = new ArrayList<>();
        for (UUID userId : userIds) {
            if (userId == null) {
                continue;
            }
            Set<WsClient> connections = clients.get(userId);
            if (connections != null) {
                targets.addAll(connections);
            }
        }
        if (targets.isEmpty()) {
            return;
        }
        for (WsClient client : targets) {
            if (!client.enqueue(event)) {
                log.warn("dropping slow websocket client: user_id={} session_id={}",
                        client.userId(), client.sessionId());
                client.closeSlow();
            }
        }
    }

    @Override
    public boolean isOnline(UUID userId) {
        if (userId == null) {
            return false;
        }
        Set<WsClient> connections = clients.get(userId);
        return connections != null && !connections.isEmpty();
    }

    /** Число пользователей с активными соединениями (GET /api/v1/status). */
    @Override
    public int onlineUsers() {
        return clients.size();
    }

    /** Общее число активных соединений (мультидевайс считается поштучно). */
    @Override
    public int connections() {
        int total = 0;
        for (Set<WsClient> connections : clients.values()) {
            total += connections.size();
        }
        return total;
    }

    /**
     * Закрывает все соединения (корректная остановка сервиса). После вызова
     * присутствие не рассылается: БД может быть уже недоступна.
     */
    public void closeAll(String reason) {
        List<WsClient> targets = new ArrayList<>();
        synchronized (clients) {
            shuttingDown = true;
            for (Set<WsClient> connections : clients.values()) {
                targets.addAll(connections);
            }
            clients.clear();
        }
        for (WsClient client : targets) {
            client.closeWithReason(reason);
        }
        if (!targets.isEmpty()) {
            log.info("websocket connections closed: count={} reason={}", targets.size(), reason);
        }
    }

    @PreDestroy
    public void onShutdown() {
        closeAll("server is shutting down");
    }

    /**
     * Рассылает событие присутствия собеседникам пользователя. Ошибка резолва
     * собеседников не роняет соединение — только логируется.
     */
    private void broadcastPresence(UUID userId, String status) {
        List<UUID> targets = onlinePeersOf(userId);
        if (targets.isEmpty()) {
            return;
        }
        sendToUsers(targets, Events.newEvent(Events.PRESENCE,
                new Events.PresencePayload(userId, status, lastSeenOf(userId))));
    }

    /**
     * Снимок присутствия собеседников для нового соединения: собеседники,
     * которые уже онлайн, получают "presence online" о себе — иначе клиент,
     * подключившийся последним, не узнал бы о них до следующей смены статуса.
     */
    private void sendPeersOnlineToUser(UUID userId) {
        List<UUID> peers = peersOf(userId);
        for (UUID peerId : peers) {
            if (peerId == null || peerId.equals(userId) || !isOnline(peerId)) {
                continue;
            }
            sendToUsers(List.of(userId), Events.newEvent(Events.PRESENCE,
                    new Events.PresencePayload(peerId, "online", lastSeenOf(peerId))));
        }
    }

    private List<UUID> onlinePeersOf(UUID userId) {
        List<UUID> peers = peersOf(userId);
        List<UUID> targets = new ArrayList<>(peers.size());
        for (UUID peerId : peers) {
            if (peerId != null && !peerId.equals(userId)) {
                targets.add(peerId);
            }
        }
        return targets;
    }

    /** Собеседники по общим диалогам; ошибка резолва логируется и даёт пустой список. */
    private List<UUID> peersOf(UUID userId) {
        ChatCommands peers = chat.getIfAvailable();
        if (peers == null) {
            return List.of();
        }
        try {
            List<UUID> ids = peers.peersOf(userId);
            return ids == null ? List.of() : ids;
        } catch (RuntimeException e) {
            log.error("resolve peers for presence failed: user_id={} reason={}", userId, e.toString());
            return List.of();
        }
    }

    private Instant lastSeenOf(UUID userId) {
        try {
            User user = userLookup.byId(userId);
            return user == null ? null : user.lastSeenAt();
        } catch (RuntimeException e) {
            // Пользователь мог быть удалён между подключением и presence.
            log.debug("last seen lookup for presence failed: user_id={} reason={}", userId, e.toString());
            return null;
        }
    }
}
