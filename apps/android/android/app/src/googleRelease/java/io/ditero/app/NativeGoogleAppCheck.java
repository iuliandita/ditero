package io.ditero.app;

import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

final class NativeGoogleAppCheck {
    static void install(FirebaseAppCheck check) {check.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance());}
}
