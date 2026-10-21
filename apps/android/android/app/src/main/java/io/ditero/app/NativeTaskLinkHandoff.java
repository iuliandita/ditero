package io.ditero.app;

import androidx.lifecycle.ViewModel;

/** Retains only pre-handshake ingress across configuration recreation, never process death. */
public final class NativeTaskLinkHandoff extends ViewModel {
    final NativeTaskLink.Slot<NativeSessionVault.CapturedOwner> pending = new NativeTaskLink.Slot<>();
    boolean refused;

    void clear() {
        pending.clear();
        refused = false;
    }

    void retire(boolean changingConfigurations, boolean pageBound) {
        if (!changingConfigurations) clear();
        else if (pageBound) {
            boolean unavailable = pending.occupied() || refused;
            clear();
            refused = unavailable;
        }
    }

    @Override
    protected void onCleared() {
        clear();
    }
}
