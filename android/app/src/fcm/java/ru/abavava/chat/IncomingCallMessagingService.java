package ru.abavava.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class IncomingCallMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL = "incoming_calls";
    private static final String MESSAGE_CHANNEL = "new_messages";

    @Override public void onNewToken(String token) {
        getSharedPreferences("push", MODE_PRIVATE).edit().putString("token", token).apply();
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        if (MainActivity.isVisible()) return;
        String type = message.getData().get("type");
        if ("incoming_call".equals(type)) {
            showIncomingCall(message);
        } else if ("new_message".equals(type)) {
            showNewMessage();
        }
    }

    private void showIncomingCall(RemoteMessage message) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String caller = message.getData().getOrDefault("caller", "Входящий звонок");
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(ru.abavava.chat.R.drawable.ic_launcher)
                .setContentTitle(caller).setContentText("Входящий видеозвонок")
                .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true).setAutoCancel(true).setContentIntent(tap);
        manager.notify(message.getData().getOrDefault("call_id", "call").hashCode(), notification.build());
    }

    private void showNewMessage() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(
                MESSAGE_CHANNEL, "Новые сообщения", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, MESSAGE_CHANNEL)
                .setSmallIcon(ru.abavava.chat.R.drawable.ic_launcher)
                .setContentTitle("Новое сообщение")
                .setContentText("Откройте приложение, чтобы прочитать сообщение")
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(tap);
        manager.notify(2, notification.build());
    }
}
