package com.abavava.chat.call;

import jakarta.annotation.PreDestroy;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Стартовая и завершающая работа модуля звонков:
 * <ul>
 *   <li>при старте — {@link CallService#reconcile()}: закрывает звонки,
 *       «зависшие» после перезапуска (таймеры дозвона живут в памяти);</li>
 *   <li>при остановке — {@link CallService#close()}: отменяет таймеры и
 *       освобождает поток планировщика.</li>
 * </ul>
 */
@Component
public class CallReconcileRunner implements ApplicationRunner {

    private final CallService callService;

    public CallReconcileRunner(CallService callService) {
        this.callService = callService;
    }

    @Override
    public void run(ApplicationArguments args) {
        callService.reconcile();
    }

    @PreDestroy
    public void shutdown() {
        callService.close();
    }
}
