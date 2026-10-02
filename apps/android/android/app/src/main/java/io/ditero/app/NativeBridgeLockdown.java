package io.ditero.app;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import org.json.JSONException;
import org.json.JSONObject;

/** Removes Capacitor's generic transports before its first page navigation. */
@CapacitorPlugin(name = "NativeBridgeLockdown")
public final class NativeBridgeLockdown extends Plugin {
    private boolean ready;

    boolean isReady() { return ready; }

    @Override public void load() {
        WebView view = getBridge().getWebView();
        try {
            boolean modern = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
            if (modern) WebViewCompat.removeWebMessageListener(view, "androidBridge");
            view.removeJavascriptInterface("androidBridge");
            view.removeJavascriptInterface("CapacitorHttpAndroidInterface");
            view.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
            if (!modern) throw new IllegalStateException("modern bridge required");
            WebViewCompat.addWebMessageListener(view, "androidBridge", Collections.singleton("https://localhost"),
                    (webView, message, origin, mainFrame, reply) -> {
                        if (!mainFrame || !bundled(origin) || message.getType() != WebMessageCompat.TYPE_STRING) return;
                        String raw = message.getData();
                        if (raw == null || raw.length() > 8192) return;
                        try {
                            JSONObject input = new JSONObject(raw);
                            Object value = input.opt("callbackId");
                            if (!(value instanceof String) || !((String) value).matches("[0-9]{1,20}")) return;
                            JSONObject error = new JSONObject().put("code", "FORBIDDEN")
                                    .put("message", "Native plugin calls are disabled");
                            reply.postMessage(new JSONObject().put("callbackId", value).put("success", false)
                                    .put("save", false).put("error", error).toString());
                        } catch (JSONException | RuntimeException ignored) {
                            // A malformed request never reaches any native plugin.
                        }
                    });
            ready = true;
        } catch (RuntimeException error) {
            ready = false;
            view.stopLoading();
            Log.e("NativeBridgeLockdown", "generic bridge removal failed closed");
        }
    }

    private static boolean bundled(Uri origin) {
        return origin != null && "https".equals(origin.getScheme()) && "localhost".equals(origin.getHost())
                && (origin.getPort() == -1 || origin.getPort() == 443) && origin.getUserInfo() == null;
    }
}
