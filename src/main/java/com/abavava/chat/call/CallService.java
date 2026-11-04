package com.abavava.chat.call;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.Broadcaster;
import com.abavava.chat.contract.CallCommands;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.contract.NoopBroadcaster;
import com.abavava.chat.contract.UserLookup;
import com.abavava.chat.domain.AbvException;
import com.abavava.chat.domain.Call;
import com.abavava.chat.domain.CallKind;
import com.abavava.chat.domain.CallStatus;
import com.abavava.chat.domain.Events;
import com.abavava.chat.domain.User;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Состояние звонков, таймеры дозвона и транзит WebRTC-сигналинга
 * (аналог call/service.go). Медиатрафик через сервер не идёт: сервер хранит
 * состояние, рассылает события и пересылает SDP/ICE второму участнику.
 *
 * <p>Зависимости от соседних модулей — только через contract/: {@link UserLookup},
 * {@link ChatCommands}, {@link Broadcaster}. Broadcaster берётся лениво через
 * {@link ObjectProvider}, потому что realtime-слой (Hub) зависит от
 * CallCommands и при старте контекста возникает цикл.
 */
@Service
public class CallService implements CallCommands {

    private static final Logger log = LoggerFactory.getLogger(CallService.class);

    static final String REASON_HANGUP = "hangup";
    static final String REASON_REJECTED = "rejected";
    static final String REASON_TIMEOUT = "timeout";

    /** Параметры инициации звонка (Go: StartInput). kind — «сырая» строка из JSON. */
    public record StartInput(UUID calleeId, String kind, UUID conversationId) {
    }

    private final CallRepository repo;
    private final UserLookup users;
    private final ChatCommands chat;
    private final ObjectProvider<Broadcaster> broadcasterProvider;
    /** Таймаут дозвона (abv.call-ring-timeout). */
    private final Duration ringTimeout;

    /** Один поток на все таймеры дозвона: порядок срабатываний предсказуем. */
    private final ScheduledExecutorService scheduler;
    private final Map<UUID, ScheduledFuture<?>> ringTimers = new HashMap<>();
    private boolean closed;

    public CallService(CallRepository repo,
                       UserLookup users,
                       ChatCommands chat,
                       ObjectProvider<Broadcaster> broadcasterProvider,
                       AbvProperties properties) {
        this.repo = repo;
        this.users = users;
        this.chat = chat;
        this.broadcasterProvider = broadcasterProvider;
        // Валидность (положительный Duration) проверяется в AbvProperties.validate().
        this.ringTimeout = properties.callRingTimeout();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "call-ring-timer");
            thread.setDaemon(true);
            return thread;
        });
    }

    // ------------------------------------------------------------------ start

    /**
     * Создаёт звонок, уведомляет участников и взводит таймер дозвона.
     * Если вызываемый не в сети, звонок сразу фиксируется как missed.
     */
    public Call start(UUID actor, StartInput in) {
        if (in.calleeId() == null) {
            throw AbvException.invalidField("callee_id", "callee_id is required");
        }
        if (in.calleeId().equals(actor)) {
            throw AbvException.invalid("cannot call yourself");
        }
        CallKind kind = parseKind(in.kind());

        // Профили обеих сторон нужны, чтобы каждая сторона получила в поле peer
        // собеседника: звонящий — вызываемого, вызываемый — звонящего.
        User caller;
        try {
            caller = users.byId(actor);
        } catch (RuntimeException e) {
            throw AbvException.internal(e);
        }
        User callee;
        try {
            callee = users.byId(in.calleeId());
        } catch (RuntimeException e) {
            throw AbvException.notFound("user you are calling does not exist");
        }

        // Один активный звонок на пользователя в любой роли: частичные уникальные
        // индексы ловят только совпадение роли, поэтому проверяем явно.
        if (repo.activeForUser(actor) != null) {
            throw AbvException.conflict("you are already in a call");
        }
        if (repo.activeForUser(in.calleeId()) != null) {
            throw AbvException.conflict("the person you are calling is busy");
        }

        UUID conversationId = in.conversationId();
        if (conversationId != null) {
            List<UUID> members = chat.memberIds(conversationId);
            if (members == null || !members.contains(actor) || !members.contains(in.calleeId())) {
                throw AbvException.notFound("conversation not found");
            }
        } else {
            ChatCommands.DirectResult direct = chat.ensureDirect(actor, in.calleeId());
            conversationId = direct.view().conversation().id();
        }

        Call created = repo.create(new CallRepository.CreateCallInput(
                conversationId, actor, in.calleeId(), kind));
        repo.logEvent(created.id(), actor, "created", Map.of("kind", kind.json()));

        Broadcaster broadcaster = broadcaster();

        // Звонящий сразу видит исходящий вызов.
        broadcaster.sendToUsers(List.of(actor),
                Events.newEvent(Events.CALL_CREATED, new Events.CallPayload(created.withPeer(callee))));

        // Если у вызываемого нет активного соединения, звонить некуда: не
        // заставляем инициатора ждать впустую, а сразу фиксируем «нет ответа».
        if (!broadcaster.isOnline(in.calleeId())) {
            Call missed = repo.transition(new CallRepository.TransitionInput(
                    created.id(), CallStatus.RINGING, CallStatus.MISSED, null, REASON_TIMEOUT));
            repo.logEvent(created.id(), null, "missed", Map.of("reason", "callee offline"));
            sendCallEvent(Events.CALL_UPDATED, missed, List.of(actor));
            return missed;
        }

        broadcaster.sendToUsers(List.of(in.calleeId()),
                Events.newEvent(Events.CALL_INCOMING, new Events.CallPayload(created.withPeer(caller))));
        armRingTimer(created.id());
        return created;
    }

    // ------------------------------------------------- accept / reject / end

    /** Принимает входящий звонок (только вызываемый). */
    @Override
    public Call accept(UUID actor, UUID callId) {
        Call current = repo.byId(callId);
        if (!current.calleeId().equals(actor)) {
            throw AbvException.forbidden("only the callee can accept the call");
        }
        Call updated = repo.transition(new CallRepository.TransitionInput(
                callId, CallStatus.RINGING, CallStatus.ACCEPTED, actor, null));
        cancelRingTimer(callId);
        repo.logEvent(callId, actor, "accepted", null);
        sendCallEvent(Events.CALL_UPDATED, updated, participants(updated));
        return updated;
    }

    /** Отклоняет входящий звонок (только вызываемый). */
    @Override
    public Call reject(UUID actor, UUID callId, String reason) {
        Call current = repo.byId(callId);
        if (!current.calleeId().equals(actor)) {
            throw AbvException.forbidden("only the callee can reject the call");
        }
        Call updated = repo.transition(new CallRepository.TransitionInput(
                callId, CallStatus.RINGING, CallStatus.REJECTED, actor,
                defaultReason(reason, REASON_REJECTED)));
        cancelRingTimer(callId);
        repo.logEvent(callId, actor, "rejected", null);
        sendCallEvent(Events.CALL_UPDATED, updated, participants(updated));
        return updated;
    }

    /**
     * Завершает звонок. Кто именно повесил трубку, зависит от состояния:
     * звонящий во время дозвона — отмена, вызываемый во время дозвона —
     * отклонение, любой в разговоре — завершение.
     */
    @Override
    public Call end(UUID actor, UUID callId, String reason) {
        Call current = repo.byId(callId);
        if (!current.involved(actor)) {
            throw AbvException.forbidden("you are not a participant of this call");
        }

        CallStatus target;
        CallStatus from = current.status();
        if (from == CallStatus.RINGING) {
            target = current.callerId().equals(actor) ? CallStatus.CANCELED : CallStatus.REJECTED;
        } else if (from == CallStatus.ACCEPTED) {
            target = CallStatus.ENDED;
        } else {
            throw AbvException.conflict("call is already %s", from.json());
        }

        Call updated = repo.transition(new CallRepository.TransitionInput(
                callId, from, target, actor, defaultReason(reason, REASON_HANGUP)));
        cancelRingTimer(callId);
        repo.logEvent(callId, actor, "ended", Map.of("status", target.json()));
        sendCallEvent(Events.CALL_UPDATED, updated, participants(updated));
        return updated;
    }

    // ---------------------------------------------------------------- signal

    /**
     * Транзитом передаёт SDP/ICE второму участнику. Содержимое payload сервер
     * не разбирает — только проверяет права и активность звонка.
     */
    @Override
    public void signal(UUID actor, UUID callId, Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            throw AbvException.invalidField("payload", "payload is required");
        }
        Object rawType = payload.get("type");
        String type = rawType instanceof String s ? s : "";
        if (!"offer".equals(type) && !"answer".equals(type) && !"candidate".equals(type)) {
            throw AbvException.invalidField("payload.type",
                    "payload.type must be \"offer\", \"answer\" or \"candidate\"");
        }

        Call current = repo.byId(callId);
        if (!current.involved(actor)) {
            throw AbvException.forbidden("you are not a participant of this call");
        }
        if (current.status().terminal()) {
            throw AbvException.conflict("call is already %s", current.status().json());
        }

        UUID peer = current.party(actor);
        Broadcaster broadcaster = broadcaster();
        if (!broadcaster.isOnline(peer)) {
            log.warn("signal for offline peer dropped: call_id={} peer_id={}", callId, peer);
            throw AbvException.conflict("the other participant is offline");
        }
        broadcaster.sendToUsers(List.of(peer),
                Events.newEvent(Events.CALL_SIGNAL, new Events.SignalPayload(callId, actor, payload)));
    }

    // --------------------------------------------------- чтение состояния

    /** История звонков с профилем собеседника (удалённый профиль пропускаем). */
    public List<Call> history(UUID actor, int limit) {
        List<Call> calls = repo.history(actor, limit);
        Set<UUID> peers = new LinkedHashSet<>();
        for (Call c : calls) {
            peers.add(c.party(actor));
        }
        Map<UUID, User> profiles = new HashMap<>();
        for (UUID id : peers) {
            User profile = users.findById(id);
            if (profile != null) {
                profiles.put(id, profile);
            }
        }
        List<Call> out = new ArrayList<>(calls.size());
        for (Call c : calls) {
            out.add(c.withPeer(profiles.get(c.party(actor))));
        }
        return out;
    }

    /** Звонок участнику; постороннему — not_found (не раскрываем существование). */
    public Call get(UUID actor, UUID callId) {
        Call call = repo.byId(callId);
        if (!call.involved(actor)) {
            throw AbvException.notFound("call not found");
        }
        User peer = users.findById(call.party(actor));
        return peer == null ? call : call.withPeer(peer);
    }

    /** Активный звонок пользователя: нужен после переподключения по WS. */
    public Call activeForUser(UUID actor) {
        return repo.activeForUser(actor);
    }

    /** Закрывает звонки, «зависшие» после перезапуска сервиса. */
    public void reconcile() {
        try {
            long count = repo.reconcileMissed(ringTimeout);
            if (count > 0) {
                log.info("reconciled ringing calls: count={}", count);
            }
        } catch (RuntimeException e) {
            log.error("reconcile ringing calls", e);
        }
    }

    // --------------------------------------------------------------- таймеры

    /**
     * Останавливает все таймеры дозвона и освобождает поток.
     * Вызывается из {@code call.CallReconcileRunner#shutdown()} (@PreDestroy).
     */
    public void close() {
        synchronized (ringTimers) {
            closed = true;
            for (ScheduledFuture<?> timer : ringTimers.values()) {
                timer.cancel(false);
            }
            ringTimers.clear();
        }
        scheduler.shutdownNow();
    }

    private void armRingTimer(UUID callId) {
        synchronized (ringTimers) {
            if (closed) {
                return;
            }
            ScheduledFuture<?> timer = scheduler.schedule(
                    () -> onRingTimeout(callId), ringTimeout.toMillis(), TimeUnit.MILLISECONDS);
            ScheduledFuture<?> old = ringTimers.put(callId, timer);
            if (old != null) {
                old.cancel(false);
            }
        }
    }

    private void cancelRingTimer(UUID callId) {
        synchronized (ringTimers) {
            ScheduledFuture<?> timer = ringTimers.remove(callId);
            if (timer != null) {
                timer.cancel(false);
            }
        }
    }

    /** Переводит неотвеченный звонок в missed; гонка с accept/end — норма. */
    private void onRingTimeout(UUID callId) {
        synchronized (ringTimers) {
            ringTimers.remove(callId);
            if (closed) {
                return;
            }
        }
        try {
            Call updated = repo.transition(new CallRepository.TransitionInput(
                    callId, CallStatus.RINGING, CallStatus.MISSED, null, REASON_TIMEOUT));
            repo.logEvent(callId, null, "missed", Map.of("reason", "timeout"));
            sendCallEvent(Events.CALL_UPDATED, updated, participants(updated));
        } catch (AbvException e) {
            if (e.code() == AbvException.Code.CONFLICT) {
                return; // уже принят или завершён — это нормальная гонка
            }
            log.error("ring timeout transition: call_id={}", callId, e);
        } catch (RuntimeException e) {
            log.error("ring timeout transition: call_id={}", callId, e);
        }
    }

    // -------------------------------------------------------------- рассылка

    /** Broadcaster или no-op, если realtime-слой ещё не собран. */
    private Broadcaster broadcaster() {
        return broadcasterProvider.getIfAvailable(() -> NoopBroadcaster.INSTANCE);
    }

    /**
     * Рассылает событие звонка указанным получателям, подставляя каждому
     * профиль собеседника в поле peer.
     */
    private void sendCallEvent(String eventType, Call call, Collection<UUID> recipients) {
        Broadcaster broadcaster = broadcaster();
        for (UUID recipient : recipients) {
            Call payload = call;
            UUID peerId = call.party(recipient);
            User peer = users.findById(peerId);
            if (peer != null) {
                payload = call.withPeer(peer);
            } else {
                log.warn("load peer profile for call event: peer_id={}", peerId);
            }
            try {
                broadcaster.sendToUsers(List.of(recipient),
                        Events.newEvent(eventType, new Events.CallPayload(payload)));
            } catch (RuntimeException e) {
                // Транспорт вторичен: смена состояния уже зафиксирована в БД.
                log.warn("send call event: call_id={} type={} user_id={}",
                        call.id(), eventType, recipient, e);
            }
        }
    }

    private static List<UUID> participants(Call call) {
        return List.of(call.callerId(), call.calleeId());
    }

    /** "" | null → audio; иначе audio|video; прочее — валидационная ошибка. */
    private static CallKind parseKind(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return CallKind.AUDIO;
        }
        try {
            return CallKind.fromJson(value);
        } catch (IllegalArgumentException e) {
            throw AbvException.invalidField("kind", "kind must be \"audio\" or \"video\"");
        }
    }

    private static String defaultReason(String reason, String fallback) {
        if (reason == null) {
            return fallback;
        }
        String trimmed = reason.strip();
        return trimmed.isEmpty() ? fallback : trimmed;
    }
}
