package com.abavava.chat.http;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.security.JwtService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.ObjectMapper;

/** Бин JWT-сервиса: секрет и TTL из секции abv (application.yml / ABV_*). */
@Configuration
public class JwtConfig {

    @Bean
    public JwtService jwtService(AbvProperties props, ObjectMapper mapper) {
        return new JwtService(props.jwtSecret(), props.accessTtl(), mapper);
    }
}
