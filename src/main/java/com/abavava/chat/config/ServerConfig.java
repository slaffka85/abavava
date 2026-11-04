package com.abavava.chat.config;

import org.springframework.boot.web.server.ConfigurableWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Configuration;

/**
 * Порт из abv.http-addr (по умолчанию :8082 из application.yml) и проверка
 * конфигурации, повторяющая config.Load() в Go.
 */
@Configuration
public class ServerConfig implements WebServerFactoryCustomizer<ConfigurableWebServerFactory> {

    private final AbvProperties props;

    public ServerConfig(AbvProperties props) {
        this.props = props;
        props.validate();
    }

    @Override
    public void customize(ConfigurableWebServerFactory factory) {
        factory.setPort(props.serverPort());
    }
}
