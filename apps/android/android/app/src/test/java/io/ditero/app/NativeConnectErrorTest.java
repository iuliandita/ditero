package io.ditero.app;

import static org.junit.Assert.assertEquals;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.security.cert.CertificateException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.junit.Test;

public class NativeConnectErrorTest {
    @Test public void classifiesWrappedNativeFailuresWithoutExposingExceptionMessages() {
        assertEquals("server-not-found", NativeConnectError.classify(new IOException("transport", new UnknownHostException("private host"))));
        for (Throwable error : new Throwable[]{new CertificateException(), new SSLHandshakeException("trust"), new SSLPeerUnverifiedException("host")})
            assertEquals("certificate-not-trusted", NativeConnectError.classify(new IOException("transport", error)));
        for (Throwable error : new Throwable[]{new ConnectException(), new SocketTimeoutException(), new IOException()})
            assertEquals("server-unreachable", NativeConnectError.classify(error));
        IOException combined = new IOException(new UnknownHostException());
        combined.addSuppressed(new CertificateException());
        assertEquals("certificate-not-trusted", NativeConnectError.classify(combined));
    }
}
