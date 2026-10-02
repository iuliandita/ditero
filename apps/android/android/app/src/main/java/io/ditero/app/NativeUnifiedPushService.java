package io.ditero.app;

import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/** SDK receiver dispatches here even when the Activity does not exist. */
public final class NativeUnifiedPushService extends PushService {
    @Override public void onNewEndpoint(PushEndpoint endpoint,String instance) {NativePushCoordinator.get(this).endpoint(endpoint,instance);}
    @Override public void onMessage(PushMessage message,String instance) {NativePushCoordinator.get(this).message(message.getContent(),message.getDecrypted(),instance);}
    @Override public void onRegistrationFailed(FailedReason reason,String instance) {NativePushCoordinator.get(this).unavailable(instance,"registration-failed",false);}
    @Override public void onUnregistered(String instance) {NativePushCoordinator.get(this).unavailable(instance,"registration-failed",true);}
    @Override public void onTempUnavailable(String instance) {NativePushCoordinator.get(this).unavailable(instance,"temporary-unavailable",false);}
}
