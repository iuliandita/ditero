package io.ditero.app;

import java.net.UnknownHostException;
import java.security.cert.CertificateException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;

/** Public connection diagnostics only; never an authorization or offline-fallback decision. */
final class NativeConnectError {
    static String classify(Throwable error) {
        ArrayList<Throwable> pending = new ArrayList<>();
        Set<Throwable> seen = new HashSet<>();
        pending.add(error);
        boolean dns = false;
        for (int i = 0; i < pending.size(); i++) {
            Throwable current = pending.get(i);
            if (!seen.add(current)) continue;
            if (current instanceof CertificateException || current instanceof SSLPeerUnverifiedException
                    || current instanceof SSLHandshakeException) return "certificate-not-trusted";
            if (current instanceof UnknownHostException) dns = true;
            if (current.getCause() != null) pending.add(current.getCause());
            for (Throwable suppressed : current.getSuppressed()) pending.add(suppressed);
        }
        return dns ? "server-not-found" : "server-unreachable";
    }
}
