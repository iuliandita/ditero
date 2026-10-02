package io.ditero.app;

import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory;

final class NativeGoogleAppCheck {
    static void install(FirebaseAppCheck check) {check.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance());}
}
