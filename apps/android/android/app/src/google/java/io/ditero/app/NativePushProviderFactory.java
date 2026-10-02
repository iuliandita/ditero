package io.ditero.app;

import android.content.Context;

final class NativePushProviderFactory {
    static NativePushProvider create(Context context, NativePushCoordinator coordinator) {
        return new NativeGooglePushProvider(context,coordinator,NativeGoogleConfiguration.load(context));
    }
}
