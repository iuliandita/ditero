package io.ditero.app;

import android.os.Bundle;
import android.content.Intent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NativeZeroTransport zeroTransport;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        NativeBridgeLockdown lockdown = new NativeBridgeLockdown();
        bridgeBuilder.addPluginInstance(lockdown);
        super.onCreate(savedInstanceState);
        if (!lockdown.isReady()) {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().stopLoading();
                getBridge().getWebView().loadUrl("about:blank");
            }
            return;
        }
        // Shell policy first: it replaces the bridge's clients. If it fails closed, the view
        // is parked on about:blank and no native transport is attached.
        // Dedicated message listener only; null means registration failed closed.
        zeroTransport = NativeShellPolicy.install(this) ? NativeZeroTransport.attach(this) : null;
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (zeroTransport != null && zeroTransport.activityResult(requestCode,resultCode,data)) return;
        super.onActivityResult(requestCode,resultCode,data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] grantResults) {
        super.onRequestPermissionsResult(requestCode,permissions,grantResults);
        if(zeroTransport!=null && (requestCode==7346 || requestCode==7347)) zeroTransport.pushPermissionResult(requestCode);
    }

    @Override
    public void onDestroy() {
        if (zeroTransport != null) zeroTransport.drain();
        zeroTransport = null;
        super.onDestroy();
    }
}
