package io.ditero.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Map;
import java.util.UUID;

/** Durable epochs and encrypted captured credentials survive Activity and process death. */
final class NativePushStore {
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
        try {
            String origin=prefs.getString(instance+".origin",null), user=prefs.getString(instance+".user",null);
            ServerContext context=ServerContext.parse(origin);
            Map<String,Object> record=NativeSessionVault.decode(context.scope(user),user,prefs.getString(instance+".blob",""));
            NativeSessionVault.CapturedOwner owner=NativeSessionVault.capture(context,record,false);
            return owner==null ? null : new Owner(instance,owner);
        } catch(Exception e) {return null;}
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
    boolean selected(Owner owner) {
        if(owner==null || !owner.instance.equals(prefs.getString("active",null))) return false;
        try {
            ServerContext context=ServerContext.parse(vault.preferences().getString(NativeSessionVault.PREF_SELECTED,null));
            String user=vault.preferences().getString(NativeSessionVault.pointerKey(context),null);
            if(!owner.session.userId.equals(user)) return false;
            Map<String,Object> record=NativeSessionVault.decode(context.scope(user),user,
                    vault.preferences().getString(NativeSessionVault.blobKey(context.scope(user)),""));
            return NativeSessionVault.sameOwner(owner.session,NativeSessionVault.capture(context,record,false));
        } catch(Exception e) {return false;}
    }
    boolean current(Owner owner) {
        return owner!=null && owner.instance.equals(prefs.getString("active",null)) && vault.isCurrent(owner.session);
    }
    boolean retire() {
        String instance=prefs.getString("active",null);
        SharedPreferences.Editor edit=prefs.edit().remove("active").putString("state","disabled");
        if(instance!=null) edit.putBoolean(instance+".retired",true);
        return edit.commit();
    }
    boolean clear(String instance) {
        SharedPreferences.Editor edit=prefs.edit();
        for(String key:prefs.getAll().keySet()) if(key.startsWith(instance+".")) edit.remove(key);
        return edit.commit();
    }
    boolean state(Owner owner,String value) {return current(owner) && prefs.edit().putString("state",value).commit();}
    boolean endpoint(Owner owner,String body) {
        if(!current(owner)) return false;
        try {
            Map<String,Object> record=NativeSessionVault.decode(owner.session.scope,owner.session.userId,prefs.getString(owner.instance+".blob",""));
            record.put("pushBody",body);
            return prefs.edit().putString(owner.instance+".blob",NativeSessionVault.encode(owner.session.scope,new org.json.JSONObject(record).toString()))
                    .putBoolean(owner.instance+".pending",true).commit();
        } catch(Exception e) {return false;}
    }
    String pending(Owner owner) {
        if(owner==null || !prefs.getBoolean(owner.instance+".pending",false)) return null;
        try {
            Object body=NativeSessionVault.decode(owner.session.scope,owner.session.userId,prefs.getString(owner.instance+".blob","")).get("pushBody");
            return body instanceof String && ((String)body).length()<=8192 ? (String)body : null;
        } catch(Exception e) {return null;}
    }
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
