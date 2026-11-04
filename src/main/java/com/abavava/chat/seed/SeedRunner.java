package com.abavava.chat.seed;

import com.abavava.chat.config.AbvProperties;
import com.abavava.chat.contract.ChatCommands;
import com.abavava.chat.domain.ConversationView;
import com.abavava.chat.domain.User;
import com.abavava.chat.security.Passwords;
import com.abavava.chat.user.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Демо-данные для локальной разработки (аналог cmd/seed в Go): три
 * пользователя и личные диалоги между ними.
 *
 * <p>Включается явно: abv.seed=true в application.yml (переопределяется
 * ABV_SEED=true из окружения) или аргумент --seed. Повторный запуск безопасен.
 * В продакшене отказывает.
 */
@Component
@Order(2)
public class SeedRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SeedRunner.class);
    private static final String DEFAULT_DEMO_PASSWORD = "password123";

    private final AbvProperties props;
    private final UserRepository users;
    private final ChatCommands chats;

    public SeedRunner(AbvProperties props, UserRepository users, ChatCommands chats) {
        this.props = props;
        this.users = users;
        this.chats = chats;
    }

    private record DemoUser(String email, String displayName, String password) {
    }

    private record DemoAccount(User user, boolean created) {
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!enabled(args)) {
            return;
        }
        if (props.isProduction()) {
            throw new IllegalStateException("refusing to seed a production database (ABV_ENV=production)");
        }

        List<DemoUser> demo = List.of(
                new DemoUser("anya@example.com", "Аня", DEFAULT_DEMO_PASSWORD),
                new DemoUser("pavel@example.com", "Павел", DEFAULT_DEMO_PASSWORD),
                new DemoUser("test", "Тест", "test"));

        List<User> ids = new ArrayList<>();
        for (DemoUser u : demo) {
            DemoAccount account = upsert(u);
            ids.add(account.user());
            log.info("seed {} {} <{}> id={}", account.created() ? "created" : "exists",
                    account.user().displayName(), account.user().email(), account.user().id());
        }

        for (int i = 0; i < ids.size(); i++) {
            for (int j = i + 1; j < ids.size(); j++) {
                ChatCommands.DirectResult result = chats.ensureDirect(ids.get(i).id(), ids.get(j).id());
                ConversationView view = result.view();
                log.info("seed {} direct {} ↔ {} id={}",
                        result.created() ? "created" : "exists",
                        ids.get(i).displayName(), ids.get(j).displayName(), view.conversation().id());
            }
        }

        log.info("Demo accounts are ready; credentials are not written to application logs.");
    }

    private boolean enabled(ApplicationArguments args) {
        return props.seed() || args.containsOption("seed");
    }

    private DemoAccount upsert(DemoUser u) {
        UserRepository.Account existing = users.accountByEmail(u.email());
        if (existing != null) {
            return new DemoAccount(existing.user(), false);
        }
        String password = u.password() == null || u.password().isEmpty() ? DEFAULT_DEMO_PASSWORD : u.password();
        String hash = Passwords.hash(password);
        User created = users.createAccount(u.email(), u.displayName(), hash);
        return new DemoAccount(created, true);
    }
}
