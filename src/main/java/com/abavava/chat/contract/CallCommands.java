package com.abavava.chat.contract;

import com.abavava.chat.domain.Call;

import java.util.Map;
import java.util.UUID;

/**
 * Команды звонков, которые выполняет WebSocket-слой и REST-контроллеры.
 * Реализация — call.CallService.
 */
public interface CallCommands {

    Call accept(UUID actor, UUID callId);

    Call reject(UUID actor, UUID callId, String reason);

    Call end(UUID actor, UUID callId, String reason);

    /** Транзит SDP/ICE второму участнику (payload не интерпретируется сервером). */
    void signal(UUID actor, UUID callId, Map<String, Object> payload);
}
