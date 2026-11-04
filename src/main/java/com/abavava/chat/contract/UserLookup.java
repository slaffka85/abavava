package com.abavava.chat.contract;

import com.abavava.chat.domain.User;

import java.util.UUID;

/** Доступ к профилям, нужный auth/realtime/call. Реализация — user.UserRepository. */
public interface UserLookup {

    /** Профиль по id; AbvException(not_found), если пользователя нет. */
    User byId(UUID id);

    /** Профиль по id или null (для мест, где удалённый пользователь не должен ронять операцию). */
    User findById(UUID id);

    /** Отметить last_seen_at (подключение/отключение WebSocket). */
    void touchLastSeen(UUID id);
}
