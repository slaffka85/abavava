package com.abavava.chat.http;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.security.JwtService;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.ObjectMapper;

/**
 * Порядок и области действия HTTP-фильтров. Порядок повторяет цепочку
 * httpx.Chain в Go: request-id, CORS, rate limit, авторизация.
 */
@Configuration
public class WebFilterConfig {

    @Bean
    public FilterRegistrationBean<RequestIdFilter> requestIdFilter() {
        FilterRegistrationBean<RequestIdFilter> bean = new FilterRegistrationBean<>(new RequestIdFilter());
        bean.addUrlPatterns("/*");
        bean.setOrder(10);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter(AbvProperties props) {
        FilterRegistrationBean<CorsFilter> bean = new FilterRegistrationBean<>(new CorsFilter(props));
        bean.addUrlPatterns("/*");
        bean.setOrder(20);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<AuthRateLimitFilter> authRateLimitFilter(AbvProperties props, ObjectMapper mapper) {
        FilterRegistrationBean<AuthRateLimitFilter> bean =
                new FilterRegistrationBean<>(new AuthRateLimitFilter(props, mapper));
        bean.addUrlPatterns("/api/v1/auth/*");
        bean.setOrder(30);
        return bean;
    }

    @Bean
    public FilterRegistrationBean<AccessTokenFilter> accessTokenFilter(JwtService jwtService, ObjectMapper mapper) {
        FilterRegistrationBean<AccessTokenFilter> bean =
                new FilterRegistrationBean<>(new AccessTokenFilter(jwtService, mapper));
        bean.addUrlPatterns("/api/v1/*");
        bean.setOrder(40);
        return bean;
    }
}
