package io.ditero.app;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Google callbacks enter the same native owner lane without an Activity. */
public final class NativeGoogleMessagingService extends FirebaseMessagingService {
    @Override public void onRegistered(String fid) {NativePushCoordinator.get(this).googleRegistered(fid);}
    @Override public void onUnregistered(String fid) {NativePushCoordinator.get(this).googleUnregistered(fid);}
    @Override public void onMessageReceived(RemoteMessage message) {
        if(message.getNotification()!=null) return;
        NativePushCoordinator.get(this).googleMessage(message.getData());
    }
}
