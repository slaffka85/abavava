package com.abavava.chat.contract;

import com.abavava.chat.domain.Events;

import java.util.Collection;
import java.util.UUID;

/**
 * То, что сервисному слою нужно от транспорта реального времени.
 * Реализация — realtime.Hub. Интерфейс объявлен отдельно, чтобы chat/call не
 * зависели от WebSocket-слоя (как domain.Broadcaster в Go).
 */
public interface Broadcaster {

    /** Доставляет событие всем активным соединениям перечисленных пользователей. */
    void sendToUsers(Collection<UUID> userIds, Events.Envelope event);

    /** Есть ли у пользователя хотя бы одно активное соединение. */
    boolean isOnline(UUID userId);
}
