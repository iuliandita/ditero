package io.ditero.app;

import android.content.SharedPreferences;
import java.util.LinkedHashMap;
import java.util.Map;

/** Encrypted operations are committed before dispatch; cancellation never discards credentials. */
final class NativeRelayStore {
    interface Codec {
        String seal(String scope,Map<String,Object> value) throws Exception;
        Map<String,Object> open(String scope,String value) throws Exception;
    }
    private final SharedPreferences prefs;
    private final Codec codec;
    NativeRelayStore(SharedPreferences prefs) {
        this(prefs,new Codec() {
            public String seal(String scope,Map<String,Object> value) throws Exception {
                return NativeSessionVault.encode(scope,NativeRelayProtocol.canonical(value));
            }
            public Map<String,Object> open(String scope,String value) throws Exception {
                return NativeSessionVault.decodeObject(scope,value);
            }
        });
    }
    NativeRelayStore(SharedPreferences prefs,Codec codec) {this.prefs=prefs;this.codec=codec;}
    private String scope(String key) {return "ditero-native-relay-v1\n"+key;}
    synchronized Map<String,Object> installation() throws Exception {return read("relay.installation");}
    synchronized boolean installation(Map<String,Object> value) throws Exception {return persist("relay.installation",value);}
    synchronized Map<String,Object> target(String instance) throws Exception {return read(instance+".relay");}
    synchronized boolean save(String instance,Map<String,Object> value) throws Exception {
        Map<String,Object> latest=target(instance);
        Map<String,Object> next=new LinkedHashMap<>(value);
        if(latest!=null && latest.get("challenge")!=null && !next.containsKey("challenge")
                && latest.get("phase").equals(next.get("phase"))
                && latest.containsKey("operation") && next.containsKey("operation")
                && object(latest.get("operation")).get("operationId").equals(object(next.get("operation")).get("operationId")))
            next.put("challenge",latest.get("challenge"));
        return persist(instance+".relay",next);
    }
    private Map<String,Object> read(String key) throws Exception {
        String value=prefs.getString(key,null);
        return value==null?null:codec.open(scope(key),value);
    }
    private boolean persist(String key,Map<String,Object> value) throws Exception {
        return prefs.edit().putString(key,codec.seal(scope(key),value)).commit();
    }
    synchronized boolean begin(NativePushStore.Owner owner,String fid,Map<String,Object> installation) throws Exception {
        if(target(owner.instance)!=null) return true;
        Map<String,Object> value=new LinkedHashMap<>();
        value.put("installationId",installation.get("installationId"));
        value.put("deviceKey",installation.get("deviceKey"));
        value.put("fid",fid); value.put("managementSecret",NativeRelayProtocol.opaqueId());
        value.put("phase","offer"); value.put("generation",1); value.put("credentialVersion",1);
        value.put("offerOperation",NativeRelayProtocol.opaqueId());value.put("offerStarted",System.currentTimeMillis()/1000);
        return save(owner.instance,value);
    }
    synchronized boolean restart(String instance,Map<String,Object> previous,String fid) throws Exception {
        Map<String,Object> next=new LinkedHashMap<>();
        next.put("installationId",previous.get("installationId"));next.put("deviceKey",previous.get("deviceKey"));
        next.put("fid",fid);next.put("managementSecret",NativeRelayProtocol.opaqueId());next.put("phase","offer");
        next.put("generation",1);next.put("credentialVersion",1);next.put("offerOperation",NativeRelayProtocol.opaqueId());
        next.put("offerStarted",System.currentTimeMillis()/1000);
        SharedPreferences.Editor edit=prefs.edit();
        if(previous.containsKey("targetId")) {
            String archive=instance+".relay-retired."+previous.get("targetId");
            Map<String,Object> retired=new LinkedHashMap<>(previous);retired.put("delegated",true);
            edit.putString(archive,codec.seal(scope(archive),retired));
        }
        return edit.putString(instance+".relay",codec.seal(scope(instance+".relay"),next)).commit();
    }
    synchronized boolean challenge(String instance,String registration,String challenge) throws Exception {
        Map<String,Object> value=target(instance);
        if(value==null || !registration.equals(value.get("registrationId")) || !NativeRelayProtocol.isOpaque(challenge)) return false;
        String phase=(String)value.get("phase");
        if(!"enroll".equals(phase) && !"replace".equals(phase) && !"confirm".equals(phase)) return false;
        Object previous=value.get("challenge");
        if(previous!=null) return previous.equals(challenge);
        value.put("challenge",challenge);
        return save(instance,value);
    }
    synchronized boolean suppressed(String instance) {
        try {Map<String,Object> value=target(instance);return value!=null && !"active".equals(value.get("phase"));}
        catch(Exception e) {return true;}
    }
    synchronized boolean hasTarget(String instance) {return prefs.contains(instance+".relay");}
    static Map<String,Object> object(Object value) {
        if(!(value instanceof Map)) throw new IllegalArgumentException("relay state");
        @SuppressWarnings("unchecked") Map<String,Object> map=(Map<String,Object>)value;
        return new LinkedHashMap<>(map);
    }
}
