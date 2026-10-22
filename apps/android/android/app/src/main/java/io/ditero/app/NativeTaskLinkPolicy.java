package io.ditero.app;

import java.util.function.BooleanSupplier;

/** Decisions behind task-link intake and standing, free of Android types so plain unit tests pin each branch. */
final class NativeTaskLinkPolicy {
    private NativeTaskLinkPolicy() {}

    enum Intake { IGNORE, REFUSE, PROCEED }

    /** Notices closer together than this, for one page generation, are coalesced. */
    static final long NOTICE_WINDOW_MS = 5000;

    /** Closed ignores; a fenced or signed-out live page refuses visibly; a fenced page nobody hears ignores. */
    static Intake intake(boolean closed, boolean live, boolean fenced, boolean signedIn) {
        if (closed) return Intake.IGNORE;
        if (fenced) return live ? Intake.REFUSE : Intake.IGNORE;
        return live && !signedIn ? Intake.REFUSE : Intake.PROCEED;
    }

    /**
     * STALE when the host moved on, the session is another account, refused or expired, or the session is not
     * verified with no check pending; UNVERIFIED only while a check is pending; otherwise OWNED unless the stored
     * record is readable and names a different owner. The stored record is read only for a verified session.
     */
    static NativeTaskLink.Standing standing(boolean usable, boolean sameSession, boolean fresh, boolean verified,
            boolean checking, BooleanSupplier storedAgrees) {
        if (!usable || !sameSession || !fresh) return NativeTaskLink.Standing.STALE;
        if (!verified) return checking ? NativeTaskLink.Standing.UNVERIFIED : NativeTaskLink.Standing.STALE;
        return storedAgrees.getAsBoolean() ? NativeTaskLink.Standing.OWNED : NativeTaskLink.Standing.STALE;
    }

    /** Lets one notice per window through for a generation; a new generation always hears its first. */
    static final class NoticeThrottle {
        private boolean any;
        private int generation;
        private long last;

        boolean allow(int generation, long nowMs) {
            if (any && this.generation == generation && nowMs - last < NOTICE_WINDOW_MS) return false;
            any = true;
            this.generation = generation;
            last = nowMs;
            return true;
        }
    }
}
