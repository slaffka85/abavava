package com.abavava.chat.contract;

import com.abavava.chat.domain.ConversationView;
import com.abavava.chat.domain.Message;

import java.util.List;
import java.util.UUID;

/**
 * Команды чата, которые выполняет WebSocket-слой и REST-контроллеры.
 * Реализация — chat.ChatService. Интерфейс зафиксирован до начала
 * параллельной разработки, чтобы realtime-модуль и звонки не зависели от
 * внутреннего устройства пакета chat.
 */
public interface ChatCommands {

    /** Отправка сообщения; created=false — идемпотентный повтор по client_id. */
    SendResult sendMessage(UUID actor, UUID conversationId, String body, String clientId);

    /** Отметка прочтения до указанного сообщения. */
    void markRead(UUID actor, UUID conversationId, UUID messageId);

    /** Индикатор набора текста (start|stop). */
    void typing(UUID actor, UUID conversationId, String state);

    /** Пользователи, с которыми у actor есть общие диалоги (рассылка presence). */
    List<UUID> peersOf(UUID userId);

    /** Участники диалога. */
    List<UUID> memberIds(UUID conversationId);

    /** Личный диалог: найти или создать (идемпотентно). */
    DirectResult ensureDirect(UUID actor, UUID peerId);

    record SendResult(Message message, boolean created) {
    }

    record DirectResult(ConversationView view, boolean created) {
    }
}
