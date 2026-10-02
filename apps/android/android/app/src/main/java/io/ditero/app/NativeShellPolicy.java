package io.ditero.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Message;
import android.util.Log;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Shell policy for the privileged WebView.
 *
 * The security principal is the trusted bundled asset set at https://localhost. Same-origin
 * scripts share one principal, so the policy keeps everything else out of the privileged
 * WebView instead of trying to tell frames apart: main-frame navigations stay on the exact
 * bundled origin, subframes are refused, foreign http(s) links go to the system browser,
 * and every other scheme or window request is denied. The entry CSP in index.html is the
 * first line for subframes; the checks here are not a caller-frame authority.
 *
 * Capacitor's own BridgeWebViewClient and BridgeWebChromeClient are subclassed, so local
 * asset serving, page lifecycle callbacks and bridge reset keep running.
 */
final class NativeShellPolicy {
    private static final String TAG = "NativeShellPolicy";
    private static final String BUNDLED_ORIGIN = "https://localhost";
    private static final int MAX_URL = 8192;

    private NativeShellPolicy() {
    }

    /**
     * Replaces the clients the Capacitor bridge installed. Fails closed: on any problem the
     * view is parked on about:blank and false is returned so the caller attaches nothing.
     */
    static boolean install(BridgeActivity activity) {
        Bridge bridge = activity.getBridge();
        if (bridge == null || bridge.getWebView() == null) return false;
        WebView view = bridge.getWebView();
        try {
            // The policy is written for the bundled origin only; a server URL would change that.
            if (bridge.getServerUrl() != null || !BUNDLED_ORIGIN.equals(bridge.getLocalUrl()))
                throw new IllegalStateException("unexpected app origin");
            bridge.setWebViewClient(new ShellWebViewClient(bridge, activity));
            // Without this, window.open could load into the privileged view; with it, the
            // request reaches onCreateWindow, which denies it.
            view.getSettings().setSupportMultipleWindows(true);
            view.setWebChromeClient(new ShellChromeClient(bridge));
            return true;
        } catch (RuntimeException e) {
            Log.e(TAG, "shell policy installation failed closed");
            view.stopLoading();
            view.loadUrl("about:blank");
            return false;
        }
    }

    // ---- predicates -----------------------------------------------------------------

    /**
     * Exactly https://localhost, then end or one of / ? #. Anything that could make Android's
     * Uri and Chromium disagree about the authority (userinfo, port, backslash, whitespace,
     * control characters, other case) is rejected rather than interpreted.
     */
    private static boolean hasBundledAuthority(String s) {
        if (s == null || s.length() > MAX_URL || !s.startsWith(BUNDLED_ORIGIN)) return false;
        if (s.length() > BUNDLED_ORIGIN.length()) {
            char next = s.charAt(BUNDLED_ORIGIN.length());
            if (next != '/' && next != '?' && next != '#') return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= ' ' || c == 0x7f || c == '\\') return false;
        }
        return true;
    }

    /** A main-frame document the privileged view may show: bundled origin, not a local proxy path. */
    static boolean isBundledDocument(Uri url) {
        return url != null && hasBundledAuthority(url.toString()) && !isLocalProxyPath(url);
    }

    /** Permission and geolocation origins: the bare bundled origin, nothing else. */
    static boolean isBundledOrigin(Uri origin) {
        if (origin == null || !hasBundledAuthority(origin.toString())) return false;
        String path = origin.getPath();
        return (path == null || path.isEmpty() || path.equals("/"))
                && origin.getQuery() == null && origin.getFragment() == null;
    }

    /**
     * Capacitor serves local files, content URIs and an HTTP proxy under the app origin. As a
     * main-frame document any of them would run foreign bytes as the app, so they never navigate.
     */
    private static boolean isLocalProxyPath(Uri url) {
        String path = url.getPath();
        for (int i = 0; i < 3 && path != null; i++) {
            while (path.startsWith("//")) path = path.substring(1);
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.startsWith(Bridge.CAPACITOR_FILE_START)
                    || lower.startsWith(Bridge.CAPACITOR_CONTENT_START)
                    || lower.startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START))
                return true;
            String decoded = Uri.decode(path);
            if (decoded.equals(path)) break;
            path = decoded;
        }
        return false;
    }

    /** Only plain http(s) with a host and no userinfo may reach the system browser. */
    private static boolean isExternalWebUrl(Uri url) {
        String s = url.toString();
        if (s.length() > MAX_URL) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= ' ' || c == 0x7f || c == '\\') return false;
        }
        String scheme = url.getScheme();
        String host = url.getHost();
        return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && host != null && !host.isEmpty() && url.getUserInfo() == null;
    }

    /** Chromium sends this on navigation requests only; Capacitor's own local server relies on it too. */
    private static boolean looksLikeDocumentNavigation(WebResourceRequest request) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return false;
        for (String name : headers.keySet())
            if ("Upgrade-Insecure-Requests".equalsIgnoreCase(name)) return true;
        return false;
    }

    private static WebResourceResponse blocked() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static void openExternal(Activity activity, Uri url) {
        if (isLocalProxyPath(url) || !isExternalWebUrl(url)) return;
        Intent intent = new Intent(Intent.ACTION_VIEW, url);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException e) {
            Log.w(TAG, "external link not opened");
        }
    }

    // ---- clients --------------------------------------------------------------------

    private static final class ShellWebViewClient extends BridgeWebViewClient {
        private final Activity activity;

        ShellWebViewClient(Bridge bridge, Activity activity) {
            super(bridge);
            this.activity = activity;
        }

        /**
         * Runs on a WebView IO thread for every request, redirects included. Main-frame
         * requests off the bundled origin never reach the network. Requests that look like
         * subframe navigations are refused as defense in depth; the CSP and
         * shouldOverrideUrlLoading are the primary subframe barriers. Everything else is
         * Capacitor's local server, unchanged.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            boolean deny = request.isForMainFrame()
                    ? !isBundledDocument(request.getUrl())
                    : looksLikeDocumentNavigation(request);
            return deny ? blocked() : super.shouldInterceptRequest(view, request);
        }

        /** Unreachable once the request overload exists; fails closed if a platform ever calls it. */
        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return blocked();
        }

        /**
         * Deliberately does not call super: Capacitor's launchIntent lets data: and blob:
         * documents load in the app view. Not called for loadUrl, same-document changes or
         * POST navigations; those are covered by shouldInterceptRequest.
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return true;
            Uri url = request.getUrl();
            if (isBundledDocument(url)) return false;
            // Foreign navigation: never in this view. Only a user-initiated, non-redirect
            // link may leave for the system browser.
            if (request.hasGesture() && !request.isRedirect()) openExternal(activity, url);
            return true;
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return true;
        }
    }

    private static final class ShellChromeClient extends BridgeWebChromeClient {
        ShellChromeClient(Bridge bridge) {
            super(bridge);
        }

        /**
         * The callback carries no target URL, only a transport into a fresh WebView, so
         * routing to the system browser would need a throwaway view. Explicit denial instead.
         */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            return false;
        }

        // Capacitor grants every non-camera/microphone request without looking at the origin.
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (!isBundledOrigin(request.getOrigin())) {
                request.deny();
                return;
            }
            super.onPermissionRequest(request);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (origin == null || !isBundledOrigin(Uri.parse(origin))) {
                callback.invoke(origin, false, false);
                return;
            }
            super.onGeolocationPermissionsShowPrompt(origin, callback);
        }
    }
}
