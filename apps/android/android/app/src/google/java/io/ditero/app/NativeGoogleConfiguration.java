package io.ditero.app;

import android.content.Context;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.util.LinkedHashMap;
import java.util.Map;

/** Pins are packaged by the operator; instance responses never supply trust. */
final class NativeGoogleConfiguration {
    final String relayOrigin;
    final Map<String,Object> receiptKeys;
    private NativeGoogleConfiguration(String origin, Map<String,Object> keys) {
        relayOrigin=origin; receiptKeys=Map.copyOf(keys);
    }
    static NativeGoogleConfiguration load(Context context) {
        try(InputStream input=context.getAssets().open("native-relay.json")) {
            ByteArrayOutputStream output=new ByteArrayOutputStream();
            byte[] buffer=new byte[1024];
            for(int size;(size=input.read(buffer))!=-1;) {
                if(output.size()+size>16384) return null;
                output.write(buffer,0,size);
            }
            byte[] bytes=output.toByteArray();
            return parse(NativeRelayProtocol.parseObject(StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()));
        } catch(Exception e) {return null;}
    }
    static NativeGoogleConfiguration parse(Map<String,Object> config) {
        try {
            if(config.size()!=2 || !(config.get("relayOrigin") instanceof String origin)
                    || !(config.get("receiptKeys") instanceof Map<?,?> keys) || keys.isEmpty() || keys.size()>8) return null;
            URI uri=new URI(origin);
            if(!"https".equals(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null
                    || uri.getQuery()!=null || uri.getFragment()!=null || !uri.getPath().isEmpty()
                    || uri.getPort()==0 || uri.getPort()>65535 || uri.getPort()==443 || !origin.equals(uri.toASCIIString())
                    || !uri.getHost().equals(uri.getHost().toLowerCase(java.util.Locale.ROOT))) return null;
            Map<String,Object> pins=new LinkedHashMap<>();
            for(Map.Entry<?,?> entry:keys.entrySet()) {
                if(!(entry.getKey() instanceof String kid) || !kid.matches("[A-Za-z0-9_-]{1,128}")
                        || !(entry.getValue() instanceof Map<?,?> raw) || raw.size()!=4
                        || !"EC".equals(raw.get("kty")) || !"P-256".equals(raw.get("crv"))
                        || !(raw.get("x") instanceof String x) || !x.matches("[A-Za-z0-9_-]{43}")
                        || !(raw.get("y") instanceof String y) || !y.matches("[A-Za-z0-9_-]{43}")) return null;
                Map<String,Object> jwk=Map.of("kty","EC","crv","P-256","x",x,"y",y);
                NativeRelayProtocol.thumbprint(jwk);
                pins.put(kid,jwk);
            }
            return new NativeGoogleConfiguration(origin,pins);
        } catch(Exception e) {return null;}
    }
}
