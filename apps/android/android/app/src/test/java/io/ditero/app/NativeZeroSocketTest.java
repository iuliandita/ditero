package io.ditero.app;

import static org.junit.Assert.*;
import okio.ByteString;
import org.junit.Test;

public class NativeZeroSocketTest {
    @Test public void socketTargetsTheBundledZeroSyncPathOnly() {
        ServerContext.ZeroEndpoint zero = ServerContext.ZeroEndpoint.parse("https://zero.example.test:8443/z/");
        assertEquals("/z/sync/v53/connect", zero.socketPath);
        assertEquals("wss://zero.example.test:8443/z/sync/v53/connect?clientID=c", zero.socketUrl("clientID=c"));
    }

    @Test public void binaryFramesAreRelayedUpToTheZeroPokeChunkBound() {
        assertEquals("AP9bXQ==", NativeZeroTransport.binaryFrame(ByteString.of((byte) 0, (byte) 0xff, (byte) '[', (byte) ']')));
        assertNotNull(NativeZeroTransport.binaryFrame(ByteString.of(new byte[NativeZeroTransport.MAX_BINARY])));
        assertNull(NativeZeroTransport.binaryFrame(ByteString.of(new byte[NativeZeroTransport.MAX_BINARY + 1])));
    }
}
