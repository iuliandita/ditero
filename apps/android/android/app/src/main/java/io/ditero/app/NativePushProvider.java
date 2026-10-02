package io.ditero.app;

import android.app.Activity;
import java.util.Map;

/** Flavor-specific SDK boundary. Owner and relay secrets remain native. */
interface NativePushProvider {
    String id();
    boolean available();
    void enable(Activity activity, NativePushStore.Owner owner);
    void resume(NativePushStore.Owner owner);
    void retire(NativePushStore.Owner owner);
    default String appCheck() throws Exception {throw new IllegalStateException("App Check unavailable");}
    default String relayOrigin() {return null;}
    default Map<String,Object> receiptKeys() {return Map.of();}
}
