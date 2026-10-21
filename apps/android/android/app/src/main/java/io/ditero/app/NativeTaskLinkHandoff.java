package io.ditero.app;

import androidx.lifecycle.ViewModel;

/** Retains only pre-handshake ingress across configuration recreation, never process death. */
public final class NativeTaskLinkHandoff extends ViewModel {
    final NativeTaskLink.Slot<NativeSessionVault.LinkOwner> pending = new NativeTaskLink.Slot<>();
    boolean refused;

    void clear() {
        pending.clear();
        refused = false;
    }

    /** A page said hello: only an unbound, still-owned cold link binds; any other held entry is dropped and reported. */
    void bindForHello(int generation, NativeTaskLink.Slot.Owns<NativeSessionVault.LinkOwner> owns) {
        if (pending.occupied() && !pending.rebind(generation, owns)) refused = true;
    }

    /** The one-shot unavailable flag carried by the hello reply. */
    boolean takeRefused() {
        boolean taken = refused;
        refused = false;
        return taken;
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
