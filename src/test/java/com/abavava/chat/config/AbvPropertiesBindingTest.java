package com.abavava.chat.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertySource;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * application.yml — единственный источник значений по умолчанию. Тест читает
 * именно classpath-файл (а не перечисляет свойства в коде) и проверяет, что
 * вся секция {@code abv:} биндится в {@link AbvProperties} и проходит
 * {@link AbvProperties#validate()}: опечатка или пропущенный ключ в yml роняют
 * тест, а не продовый старт.
 */
class AbvPropertiesBindingTest {

    @Test
    void applicationYmlBindsEveryAbvProperty() throws Exception {
        List<PropertySource<?>> sources = new YamlPropertySourceLoader()
                .load("application", new ClassPathResource("application.yml"));
        ConfigurationPropertySource propertySource = ConfigurationPropertySources.from(sources)
                .iterator().next();

        AbvProperties props = new Binder(propertySource)
                .bind("abv", Bindable.of(AbvProperties.class))
                .orElseThrow(() -> new AssertionError("секция abv: не найдена в application.yml"));
        props.validate();

        assertThat(props.env()).isEqualTo("development");
        assertThat(props.httpAddr()).isEqualTo(":8082");
        assertThat(props.serverPort()).isEqualTo(8082);
        assertThat(props.accessTtl()).isEqualTo(Duration.ofMinutes(15));
        assertThat(props.refreshTtl()).isEqualTo(Duration.ofHours(720));
        assertThat(props.callRingTimeout()).isEqualTo(Duration.ofSeconds(45));
        assertThat(props.maxMessageLength()).isEqualTo(4000);
        assertThat(props.allowedOriginList()).hasSize(2);

        assertThat(props.migration().waitAttempts()).isEqualTo(30);
        assertThat(props.migration().waitInterval()).isEqualTo(Duration.ofSeconds(1));

        assertThat(props.authRateLimit().limit()).isEqualTo(30);
        assertThat(props.authRateLimit().window()).isEqualTo(Duration.ofSeconds(60));

        assertThat(props.cors().maxAge()).isEqualTo(600);

        assertThat(props.ws().maxFrameSize()).isEqualTo(65536);
        assertThat(props.ws().maxSendBuffer()).isEqualTo(256);
        assertThat(props.ws().heartbeatInterval()).isEqualTo(Duration.ofSeconds(60));
        assertThat(props.ws().idleTimeout()).isEqualTo(Duration.ofSeconds(70));

        assertThat(props.chat().maxGroupMembers()).isEqualTo(64);
        assertThat(props.chat().maxTitleLength()).isEqualTo(128);
    }
}
