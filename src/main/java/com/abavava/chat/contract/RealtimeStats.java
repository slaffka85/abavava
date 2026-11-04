package com.abavava.chat.contract;

/**
 * Диагностика транспорта реального времени для GET /api/v1/status.
 * Реализация — realtime.Hub.
 */
public interface RealtimeStats {

    int onlineUsers();

    int connections();
}
