package io.ditero.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NativeZeroTransport zeroTransport;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Shell policy first: it replaces the bridge's clients. If it fails closed, the view
        // is parked on about:blank and no native transport is attached.
        // Dedicated message listener only; null means registration failed closed.
        zeroTransport = NativeShellPolicy.install(this) ? NativeZeroTransport.attach(this) : null;
    }

    @Override
    public void onDestroy() {
        if (zeroTransport != null) zeroTransport.drain();
        zeroTransport = null;
        super.onDestroy();
    }
}
