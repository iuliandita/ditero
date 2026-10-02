package io.ditero.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;
import java.util.UUID;

/** Durable epochs and encrypted captured credentials survive Activity and process death. */
class NativePushStore {
    final SharedPreferences prefs;
    final NativeSessionVault vault;
    NativePushStore(Context context) {
        prefs=context.getSharedPreferences("ditero_native_push", Context.MODE_PRIVATE);
        vault=new NativeSessionVault(context);
    }
    NativePushStore(SharedPreferences prefs,NativeSessionVault vault) {this.prefs=prefs; this.vault=vault;}
    static final class Owner {
        final String instance;
        final NativeSessionVault.CapturedOwner session;
        Owner(String instance, NativeSessionVault.CapturedOwner session) {this.instance=instance; this.session=session;}
    }
    Owner active() {return load(prefs.getString("active",null));}
    Owner load(String instance) {
        if(instance==null || !instance.matches("[a-f0-9-]{36}")) return null;
        keysUnavailable=false;
        try {
            String origin=prefs.getString(instance+".origin",null), user=prefs.getString(instance+".user",null);
            ServerContext context=ServerContext.parse(origin);
            Map<String,Object> record=NativeSessionVault.decode(context.scope(user),user,prefs.getString(instance+".blob",""));
            NativeSessionVault.CapturedOwner owner=NativeSessionVault.capture(context,record,false);
            return owner==null ? null : new Owner(instance,owner);
        } catch(NativeSessionVault.KeyUnavailableException e) {keysUnavailable=true; return null;}
        catch(Exception e) {return null;}
    }
    Owner create(NativeSessionVault.CapturedOwner session) {
        String instance=UUID.randomUUID().toString();
        String origin=session.pushConfigRequest().url().newBuilder().encodedPath("/").build().toString();
        origin=ServerContext.parse(origin).origin;
        String blob=vault.preferences().getString(NativeSessionVault.blobKey(session.scope),null);
        if(blob==null || !vault.isCurrent(session)) return null;
        if(!prefs.edit().putString(instance+".origin",origin).putString(instance+".user",session.userId)
                .putString(instance+".blob",blob).putString("active",instance).putString("state","enabling").commit()) return null;
        return new Owner(instance,session);
    }
    private boolean keysUnavailable;
    boolean keysUnavailable() {return keysUnavailable;}
    NativeSessionVault.CapturedOwner selectedOwner() {
        try {
            ServerContext context=ServerContext.parse(vault.preferences().getString(NativeSessionVault.PREF_SELECTED,null));
            String user=vault.preferences().getString(NativeSessionVault.pointerKey(context),null);
            Map<String,Object> record=NativeSessionVault.decode(context.scope(user),user,
                    vault.preferences().getString(NativeSessionVault.blobKey(context.scope(user)),""));
            return NativeSessionVault.capture(context,record,false);
        } catch(NativeSessionVault.KeyUnavailableException e) {keysUnavailable=true; return null;}
        catch(Exception e) {return null;}
    }
    NativeSessionVault.CapturedOwner verifiedOwner() {return vault.capture();}
    boolean selected(Owner owner) {
        return owner!=null && owner.instance.equals(prefs.getString("active",null))
                && NativeSessionVault.sameOwner(owner.session,selectedOwner());
    }
    boolean current(Owner owner) {
        return owner!=null && owner.instance.equals(prefs.getString("active",null))
                && NativeSessionVault.sameOwner(owner.session,verifiedOwner());
    }
    boolean retire() {
        String instance=prefs.getString("active",null);
        SharedPreferences.Editor edit=prefs.edit().remove("active").putString("state","disabled");
        if(instance!=null) edit.putBoolean(instance+".retired",true).remove(instance+".messages");
        return edit.commit();
    }
    boolean clear(String instance) {
        SharedPreferences.Editor edit=prefs.edit();
        for(String key:prefs.getAll().keySet()) if(key.startsWith(instance+".")) edit.remove(key);
        return edit.commit();
    }
    boolean state(Owner owner,String value) {return current(owner) && prefs.edit().putString("state",value).commit();}
    boolean endpoint(Owner owner,String body) {
        if(!selected(owner)) return false;
        try {
            Map<String,Object> record=readRecord(owner,".blob");
            record.put("pushBody",body);
            return writeRecord(owner,".blob",record,prefs.edit().putBoolean(owner.instance+".pending",true));
        } catch(Exception e) {return false;}
    }
    String pending(Owner owner) {
        if(owner==null || !prefs.getBoolean(owner.instance+".pending",false)) return null;
        try {
            Object body=readRecord(owner,".blob").get("pushBody");
            return body instanceof String && ((String)body).length()<=8192 ? (String)body : null;
        } catch(Exception e) {return null;}
    }
    Map<String,Object> readRecord(Owner owner,String suffix) throws Exception {
        return NativeSessionVault.decode(owner.session.scope,owner.session.userId,prefs.getString(owner.instance+suffix,""));
    }
    boolean writeRecord(Owner owner,String suffix,Map<String,Object> record,SharedPreferences.Editor edit) throws Exception {
        return edit.putString(owner.instance+suffix,NativeSessionVault.encode(owner.session.scope,new org.json.JSONObject(record).toString())).commit();
    }
    enum Deferred {STORED, FULL, FAILED, STALE}
    Deferred defer(Owner owner,Map<String,String> payload) {
        if(!selected(owner) || !payload.get("registrationId").equals(registration(owner))) return Deferred.STALE;
        try {
            Map<String,Object> record=prefs.contains(owner.instance+".messages")?readRecord(owner,".messages"):readRecord(owner,".blob");
            java.util.List<Map<String,String>> messages=messages(record);
            for(Map<String,String> existing:messages) if(existing.equals(payload)) return Deferred.STORED;
            if(messages.size()>=64) return Deferred.FULL;
            messages.add(new java.util.HashMap<>(payload)); record.put("pushMessages",messages);
            return writeRecord(owner,".messages",record,prefs.edit())?Deferred.STORED:Deferred.FAILED;
        } catch(Exception e) {return Deferred.FAILED;}
    }
    private static java.util.List<Map<String,String>> messages(Map<String,Object> record) {
        java.util.List<Map<String,String>> result=new java.util.ArrayList<>();
        Object stored=record.get("pushMessages");
        if(!(stored instanceof java.util.List)) return result;
        for(Object item:(java.util.List<?>)stored) {
            if(!(item instanceof Map)) continue;
            Map<?,?> map=(Map<?,?>)item;
            if(map.size()!=3 || !"1".equals(map.get("version")) || !(map.get("notificationId") instanceof String)
                    || !(map.get("registrationId") instanceof String)) continue;
            String notification=(String)map.get("notificationId"), registration=(String)map.get("registrationId");
            if(!notification.matches("[A-Za-z0-9_.:-]{1,128}") || !registration.matches("[A-Za-z0-9_.:-]{1,128}")) continue;
            result.add(Map.of("version","1","notificationId",notification,"registrationId",registration));
            if(result.size()>=64) break;
        }
        return result;
    }
    java.util.List<Map<String,String>> deferred(Owner owner) throws Exception {
        if(!current(owner) || !prefs.contains(owner.instance+".messages")) return java.util.List.of();
        return messages(readRecord(owner,".messages"));
    }
    boolean clearDeferred(Owner owner) {return current(owner) && prefs.edit().remove(owner.instance+".messages").commit();}
    boolean registration(Owner owner,String id,String body) {
        if(!body.equals(pending(owner))) return false;
        return current(owner) && prefs.edit().putString(owner.instance+".registration",id)
                .remove(owner.instance+".pending").putString("state","active").commit();
    }
    String registration(Owner owner) {return prefs.getString(owner.instance+".registration",null);}
    boolean expired(String instance) {
        try {
            ServerContext context=ServerContext.parse(prefs.getString(instance+".origin",null));
            String user=prefs.getString(instance+".user",null);
            Map<String,Object> record=NativeSessionVault.decode(context.scope(user),user,prefs.getString(instance+".blob",""));
            return !NativeSessionVault.unexpired((String)record.get("expiresAt"));
        } catch(Exception e) {return false;}
    }
    boolean hasSeen(Owner owner,String notification) {
        return owner!=null && prefs.getString(owner.instance+".seen","").contains("\n"+notification+"\n");
    }
    boolean seen(Owner owner,String notification) {
        String key=owner.instance+".seen";
        String seen=prefs.getString(key,"");
        if(seen.contains("\n"+notification+"\n")) return true;
        java.util.List<String> entries=new java.util.ArrayList<>();
        for(String entry:seen.split("\n")) if(!entry.isEmpty()) entries.add(entry);
        entries.add(notification);
        while(entries.size()>128) entries.remove(0);
        String next="\n"+String.join("\n",entries)+"\n";
        return !prefs.edit().putString(key,next).commit();
    }
}
