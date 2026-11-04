package com.abavava.chat.contract;

import com.abavava.chat.domain.Events;

import java.util.Collection;
import java.util.UUID;

/**
 * Broadcaster по умолчанию: используется, когда WebSocket-транспорт ещё не
 * собран (unit-тесты) или при отключённом realtime-слое.
 */
public final class NoopBroadcaster implements Broadcaster {

    public static final NoopBroadcaster INSTANCE = new NoopBroadcaster();

    private NoopBroadcaster() {
    }

    @Override
    public void sendToUsers(Collection<UUID> userIds, Events.Envelope event) {
        // no-op
    }

    @Override
    public boolean isOnline(UUID userId) {
        return false;
    }
}
