package io.ditero.app;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * A credential-free task link, ditero://task?origin=&lt;canonical HTTPS origin&gt;&amp;taskId=&lt;id&gt;.
 * It names a server and a task; it cannot select a server, sign in, switch accounts or open anything
 * the signed-in page could not already see. Pure Java, so it runs in plain unit tests.
 */
final class NativeTaskLink {
    static final String ACTION = "android.intent.action.VIEW";
    static final String SCHEME = "ditero";
    /** A link captured before its page said hello belongs to no page generation yet. */
    static final int UNBOUND = -1;
    private static final String PREFIX = "ditero://task?";
    private static final int MAX_LENGTH = 2048;

    final String origin, taskId;

    private NativeTaskLink(String origin, String taskId) {
        this.origin = origin;
        this.taskId = taskId;
    }

    /**
     * Returns null for anything but one exact link: no unknown, repeated or encoded-away fields. {@code extras}
     * means the intent carries a payload beyond its data URI (selector, clip data, MIME type); plain Bundle
     * extras are the caller's to ignore, since only action and data are ever read.
     */
    static NativeTaskLink parse(String action, String raw, boolean extras) {
        if (!ACTION.equals(action) || raw == null || raw.length() > MAX_LENGTH || extras
                || !raw.startsWith(PREFIX)) return null;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c <= ' ' || c >= 0x7f || c == '\\' || c == '#') return null;
        }
        String origin = null, taskId = null;
        for (String pair : raw.substring(PREFIX.length()).split("&", -1)) {
            int eq = pair.indexOf('=');
            if (eq < 0) return null;
            String key = pair.substring(0, eq), value = decode(pair.substring(eq + 1));
            if (value == null) return null;
            if (key.equals("origin") && origin == null) {
                origin = canonical(value);
                if (origin == null) return null;
            } else if (key.equals("taskId") && taskId == null && NativePushOpen.id(value)) {
                taskId = value;
            } else return null;
        }
        return origin == null || taskId == null ? null : new NativeTaskLink(origin, taskId);
    }

    /** The origin must already be the form ServerContext would store, so nothing is normalized away. */
    private static String canonical(String value) {
        try {
            String origin = ServerContext.parse(value).origin;
            return origin.equals(value) ? origin : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** One pass of percent-decoding. '+' is not a space here, and the bytes must be valid UTF-8. */
    private static String decode(String raw) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '+') return null;
            if (c != '%') {
                bytes.write(c);
                continue;
            }
            if (i + 2 >= raw.length()) return null;
            int high = Character.digit(raw.charAt(i + 1), 16), low = Character.digit(raw.charAt(i + 2), 16);
            if (high < 0 || low < 0) return null;
            bytes.write(high * 16 + low);
            i += 2;
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /**
     * One captured entry and its one-use token. The generation is UNBOUND until a page exists. Three kinds:
     * an owned link, a refusal (no link, no owner: the page reports it once through a null task id), and a
     * deferred link, which waits without an owner for a live verification and is never readable.
     */
    static final class Pending<O> {
        final NativeTaskLink link;
        final O owner;
        final String token;
        final boolean deferred;
        int generation;

        Pending(NativeTaskLink link, O owner, String token, int generation, boolean deferred) {
            this.link = link;
            this.owner = owner;
            this.token = token;
            this.generation = generation;
            this.deferred = deferred;
        }

        boolean refusal() {
            return link == null;
        }

        /** Null for a refusal, which the page shows as unavailable. */
        String taskId() {
            return link == null ? null : link.taskId;
        }
    }

    /** How a held owner stands with the host right now. Only STALE is proof the link must go. */
    enum Standing { OWNED, STALE, UNVERIFIED }

    /** Memory-only home of at most one pending entry. Ownership evidence is supplied by the host on each use. */
    static final class Slot<O> {
        interface Owns<O> {
            boolean owns(O owner);
        }

        interface Judge<O> {
            Standing judge(O owner);
        }

        private Pending<O> pending;
        private boolean owedRefusal;

        boolean occupied() {
            return pending != null;
        }

        boolean deferred() {
            return pending != null && pending.deferred;
        }

        /** True for a cold-start link that no page has bound yet. */
        boolean unbound() {
            return pending != null && pending.generation == UNBOUND;
        }

        /** A second link is refused, never queued, and the first stays. */
        boolean offer(NativeTaskLink link, O owner, String token, int generation) {
            if (pending != null) return false;
            pending = new Pending<>(link, owner, token, generation, false);
            return true;
        }

        boolean offerRefusal(String token, int generation) {
            if (pending != null) return false;
            pending = new Pending<>(null, null, token, generation, false);
            return true;
        }

        /** A link whose account is verified in memory but whose stored record is mid-verification. */
        boolean defer(NativeTaskLink link, String token, int generation) {
            if (pending != null) return false;
            pending = new Pending<>(link, null, token, generation, true);
            return true;
        }

        /** Live verification finished: the deferred link gets its owner and becomes readable. */
        boolean promote(O owner) {
            if (!deferred() || owner == null) return false;
            pending = new Pending<>(pending.link, owner, pending.token, pending.generation, false);
            return true;
        }

        /** Live verification did not succeed: the deferred link becomes a refusal under the same token. */
        boolean refuseDeferred() {
            if (!deferred()) return false;
            pending = new Pending<>(null, null, pending.token, pending.generation, false);
            return true;
        }

        /**
         * Intake check before a new link: drops an entry that is provably stale (another page generation, or an
         * owner that is no longer the account) and reports whether the slot is still taken. A transient
         * UNVERIFIED owner is kept, so a verification in flight cannot silently lose the first link. A cold
         * (UNBOUND) entry has no page session to compare with yet, so the cold judge decides it instead.
         */
        boolean settle(int generation, Judge<O> judge, Judge<O> coldJudge) {
            if (pending == null) return false;
            boolean wrongPage = pending.generation != UNBOUND && pending.generation != generation;
            Judge<O> standing = pending.generation == UNBOUND ? coldJudge : judge;
            if (wrongPage || (pending.owner != null && standing.judge(pending.owner) == Standing.STALE)) drop();
            return pending != null;
        }

        /** Remembers that a link arrived while this one was pending, so its refusal is not silent. */
        void noteBusy() {
            owedRefusal = true;
        }

        /** True once after the pending entry was consumed if a refusal is owed behind it. */
        boolean takeOwedRefusal() {
            boolean owed = owedRefusal && pending == null;
            if (pending == null) owedRefusal = false;
            return owed;
        }

        /** Attaches the unconsumed cold link to the page generation that just started. Anything already bound
         *  to an earlier page is dropped: it was delivered or abandoned there and must not reopen on a reload. */
        boolean rebind(int generation, Owns<O> owns) {
            if (pending != null && (pending.generation != UNBOUND || pending.refusal() || pending.deferred
                    || !owns.owns(pending.owner))) drop();
            if (pending != null) pending.generation = generation;
            return pending != null;
        }

        /** The pending entry if it is bound to this generation and still owned; otherwise it is gone. A deferred
         *  link stays but is not readable. */
        Pending<O> current(int generation, Owns<O> owns) {
            if (pending == null) return null;
            if (pending.generation != generation) drop();
            else if (pending.deferred) return null;
            else if (pending.owner != null && !owns.owns(pending.owner)) drop();
            return pending;
        }

        /** True only when the token names the pending entry, which is then consumed. Any other token is a no-op. */
        boolean dismiss(String token) {
            if (pending == null || !pending.token.equals(token)) return false;
            pending = null;
            return true;
        }

        void clear() {
            drop();
        }

        private void drop() {
            pending = null;
            owedRefusal = false;
        }
    }
}
