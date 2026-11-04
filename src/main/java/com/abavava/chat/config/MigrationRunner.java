package com.abavava.chat.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Применение SQL-миграций из classpath:migrations/*.sql при старте
 * (аналог internal/database/migrate.go): advisory lock сериализует
 * одновременный старт нескольких инстансов, каждая миграция — в транзакции,
 * уже применённые версии пропускаются.
 */
@Component
@org.springframework.core.annotation.Order(1)
public class MigrationRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(MigrationRunner.class);
    private static final long ADVISORY_LOCK_KEY = 802199401L;
    private static final String MIGRATIONS_TABLE =
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
                    + " version TEXT PRIMARY KEY,"
                    + " applied_at TIMESTAMPTZ NOT NULL DEFAULT now())";

    private final DataSource dataSource;
    private final AbvProperties props;

    public MigrationRunner(DataSource dataSource, AbvProperties props) {
        this.dataSource = dataSource;
        this.props = props;
    }

    @Override
    public void run(ApplicationArguments args) {
        waitForDatabase();
        if (!props.migrateOnStart()) {
            log.info("abv.migrate-on-start=false: migrations skipped");
            return;
        }
        applyMigrations();
    }

    /** Ожидание доступности БД (abv.migration.wait-attempts × wait-interval). */
    private void waitForDatabase() {
        AbvProperties.Migration migration = props.migration();
        int attempts = migration.waitAttempts();
        long sleepMillis = migration.waitInterval().toMillis();
        for (int attempt = 1; attempt <= attempts; attempt++) {
            try (Connection conn = dataSource.getConnection()) {
                conn.createStatement().executeQuery("SELECT 1").close();
                log.info("database connected");
                return;
            } catch (Exception e) {
                if (attempt == attempts) {
                    throw new IllegalStateException("database unavailable after " + attempts + " attempts", e);
                }
                log.warn("database not ready (attempt {}/{}): {}", attempt, attempts, e.getMessage());
                try {
                    Thread.sleep(sleepMillis);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("interrupted while waiting for database", ie);
                }
            }
        }
    }

    private void applyMigrations() {
        List<String> versions = listMigrationResources();
        try (Connection conn = dataSource.getConnection()) {
            try (Statement st = conn.createStatement()) {
                st.execute("SELECT pg_advisory_lock(" + ADVISORY_LOCK_KEY + ")");
            }
            try {
                try (Statement st = conn.createStatement()) {
                    st.execute(MIGRATIONS_TABLE);
                }
                Set<String> applied = new HashSet<>();
                try (Statement st = conn.createStatement();
                     ResultSet rs = st.executeQuery("SELECT version FROM schema_migrations")) {
                    while (rs.next()) {
                        applied.add(rs.getString(1));
                    }
                }
                int count = 0;
                for (String version : versions) {
                    if (applied.contains(version)) {
                        continue;
                    }
                    String sql = readResource(version);
                    applyOne(conn, version, sql);
                    count++;
                    log.info("migration applied: {}", version);
                }
                if (count == 0) {
                    log.info("database schema is up to date");
                }
            } finally {
                try (Statement st = conn.createStatement()) {
                    st.execute("SELECT pg_advisory_unlock(" + ADVISORY_LOCK_KEY + ")");
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("apply migrations: " + e.getMessage(), e);
        }
    }

    private void applyOne(Connection conn, String version, String sql) throws Exception {
        boolean autoCommit = conn.getAutoCommit();
        conn.setAutoCommit(false);
        try {
            // Собственный splitter: Spring ScriptUtils не понимает $$-кавычки
            // в телах функций PostgreSQL и рвёт миграцию.
            for (String statement : SqlScriptSplitter.split(sql)) {
                try (Statement st = conn.createStatement()) {
                    st.execute(statement);
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO schema_migrations (version) VALUES (?)")) {
                ps.setString(1, version);
                ps.executeUpdate();
            }
            conn.commit();
        } catch (Exception e) {
            conn.rollback();
            throw new IllegalStateException("migration " + version + " failed: " + e.getMessage(), e);
        } finally {
            conn.setAutoCommit(autoCommit);
        }
    }

    private List<String> listMigrationResources() {
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver()
                    .getResources("classpath:migrations/*.sql");
            List<String> names = new ArrayList<>();
            for (Resource resource : resources) {
                String filename = resource.getFilename();
                if (filename != null) {
                    names.add(filename);
                }
            }
            names.sort(String::compareTo);
            return names;
        } catch (Exception e) {
            throw new IllegalStateException("list migrations: " + e.getMessage(), e);
        }
    }

    private String readResource(String filename) throws Exception {
        Resource resource = new PathMatchingResourcePatternResolver()
                .getResource("classpath:migrations/" + filename);
        return new String(resource.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }
}
