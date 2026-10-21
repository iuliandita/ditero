package io.ditero.app;

import android.content.Intent;

/** The system hands a recreated or Recents-relaunched Activity its original launch intent again. */
final class NativeIntentIngress {
    private NativeIntentIngress() {}

    /** Only a fresh launch from outside the app may carry a link or notification tap. */
    static boolean launchable(boolean restored, int flags) {
        return !restored && (flags & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0;
    }
}
