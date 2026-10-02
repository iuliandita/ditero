package io.ditero.app;

import android.app.Activity;
import android.content.Context;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.tasks.Task;
import com.google.firebase.FirebaseApp;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.installations.FirebaseInstallations;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.Map;
import java.util.concurrent.TimeUnit;

final class NativeGooglePushProvider implements NativePushProvider {
    private final NativePushCoordinator coordinator;
    private final NativeGoogleConfiguration configuration;
    private boolean ready;
    private Task<Void> delegationDisabled;
    NativeGooglePushProvider(Context context, NativePushCoordinator coordinator, NativeGoogleConfiguration configuration) {
        this.coordinator=coordinator; this.configuration=configuration;
        if(configuration==null) return;
        try {
            FirebaseApp app=FirebaseApp.initializeApp(context);
            if(app==null) return;
            NativeGoogleAppCheck.install(FirebaseAppCheck.getInstance(app));
            FirebaseMessaging messaging=FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(false);
            delegationDisabled=messaging.setNotificationDelegationEnabled(false);
            ready=true;
        } catch(RuntimeException e) {ready=false;}
    }
    @Override public String id() {return "google";}
    @Override public boolean available() {return ready;}
    @Override public void enable(Activity activity, NativePushStore.Owner owner) {resume(owner);}
    @Override public void resume(NativePushStore.Owner owner) {
        if(owner==null) return;
        if(!ready) {coordinator.unavailable(owner.instance,"server-unavailable",false); return;}
        try {delegationDisabled.continueWithTask(task -> {
                    if(!task.isSuccessful()) throw new IllegalStateException("Firebase delegation disable failed");
                    return FirebaseMessaging.getInstance().register();
                }).continueWithTask(task -> {
                    if(!task.isSuccessful()) throw new IllegalStateException("Firebase registration failed");
                    return FirebaseInstallations.getInstance().getId();
                }).addOnCompleteListener(task -> {
                    if(task.isSuccessful()) coordinator.googleRegistered(owner,task.getResult());
                    else coordinator.unavailable(owner.instance,"registration-failed",false);
                });
        } catch(RuntimeException e) {coordinator.unavailable(owner.instance,"registration-failed",false);}
    }
    // unregister() affects the installation, including another current or pending owner.
    @Override public void retire(NativePushStore.Owner owner) {}
    @Override public String appCheck() throws Exception {
        if(!ready) throw new IllegalStateException("App Check unavailable");
        String token=Tasks.await(FirebaseAppCheck.getInstance().getAppCheckToken(false),10,TimeUnit.SECONDS).getToken();
        if(token==null || token.isEmpty() || token.length()>16384) throw new IllegalStateException("App Check unavailable");
        return token;
    }
    @Override public String relayOrigin() {return configuration==null?null:configuration.relayOrigin;}
    @Override public Map<String,Object> receiptKeys() {return configuration==null?Map.of():configuration.receiptKeys;}
}
