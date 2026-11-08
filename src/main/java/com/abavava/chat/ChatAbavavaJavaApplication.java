package com.abavava.chat;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Точка входа backend приложения abavava.
 *
 * <p>Тот же продукт и тот же контракт, что у Go-бэкенда: REST /api/v1,
 * WebSocket-протокол v1 и та же схема PostgreSQL. Различаются только порт
 * по умолчанию (8082) и стек реализации.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class ChatAbavavaJavaApplication {

    public static void main(String[] args) {
        SpringApplication.run(ChatAbavavaJavaApplication.class, args);
    }
}
