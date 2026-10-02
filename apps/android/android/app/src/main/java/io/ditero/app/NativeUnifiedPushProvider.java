package io.ditero.app;

import android.app.Activity;

final class NativeUnifiedPushProvider implements NativePushProvider {
    private final NativePushCoordinator coordinator;
    NativeUnifiedPushProvider(NativePushCoordinator coordinator) {this.coordinator=coordinator;}
    @Override public String id() {return "unifiedpush";}
    @Override public boolean available() {return true;}
    @Override public void enable(Activity activity, NativePushStore.Owner owner) {coordinator.unifiedEnable(activity,owner);}
    @Override public void resume(NativePushStore.Owner owner) {coordinator.unifiedResume(owner);}
    @Override public void retire(NativePushStore.Owner owner) {coordinator.unifiedRetire(owner);}
}
