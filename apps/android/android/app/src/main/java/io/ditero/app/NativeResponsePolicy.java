package io.ditero.app;

import java.util.Map;

final class NativeResponsePolicy {
    private NativeResponsePolicy() {}

    static boolean confirmsUnauthorized(int status, Map<String, Object> body) {
        return status == 401 && body != null && body.size() == 1
                && "unauthorized".equals(body.get("code"));
    }
}
