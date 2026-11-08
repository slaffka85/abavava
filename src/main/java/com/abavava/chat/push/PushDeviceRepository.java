package com.abavava.chat.push;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.UUID;

@Repository
public class PushDeviceRepository {
    private final JdbcClient jdbc;
    public PushDeviceRepository(JdbcClient jdbc) { this.jdbc = jdbc; }
    public void register(UUID userId, String token) {
        jdbc.sql("INSERT INTO push_devices(user_id, token) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id, updated_at=now()")
                .param(userId).param(token).update();
    }
    public void remove(UUID userId, String token) {
        jdbc.sql("DELETE FROM push_devices WHERE user_id=? AND token=?").param(userId).param(token).update();
    }
    public boolean hasDevices(UUID userId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM push_devices WHERE user_id=?)")
                .param(userId).query(Boolean.class).single();
    }
    public List<String> tokens(UUID userId) {
        return jdbc.sql("SELECT token FROM push_devices WHERE user_id=?").param(userId).query(String.class).list();
    }
}
