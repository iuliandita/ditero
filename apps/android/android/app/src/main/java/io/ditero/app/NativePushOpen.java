package io.ditero.app;

import java.net.URI;

/** A tap carries opaque identifiers only; it cannot select a server or account. */
final class NativePushOpen {
    static final String ACTION="io.ditero.app.PUSH_OPEN";
    final String instance, registrationId, notificationId;
    private NativePushOpen(String instance,String registrationId,String notificationId) {
        this.instance=instance; this.registrationId=registrationId; this.notificationId=notificationId;
    }
    static NativePushOpen parse(String action,String raw,boolean extras) {
        if(!ACTION.equals(action) || raw==null || raw.length()>1024 || extras) return null;
        try {
            URI uri=new URI(raw);
            if(!"ditero-push".equals(uri.getScheme()) || !"open".equals(uri.getRawAuthority())
                    || uri.getRawQuery()!=null || uri.getRawFragment()!=null || uri.getRawUserInfo()!=null || uri.getPort()!=-1) return null;
            String[] rawParts=uri.getRawPath().split("/",-1), parts=uri.getPath().split("/",-1);
            if(rawParts.length!=4 || parts.length!=4 || !parts[0].isEmpty()
                    || !parts[1].matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
                    || !id(parts[2]) || !id(parts[3])) return null;
            return new NativePushOpen(parts[1],parts[2],parts[3]);
        } catch(Exception e) {return null;}
    }
    static boolean id(String id) {return id!=null && id.matches("[A-Za-z0-9_.:-]{1,128}") && !id.equals(".") && !id.equals("..");}
    boolean matches(String activeInstance,String currentRegistration,boolean selected,boolean seen) {
        return selected && seen && instance.equals(activeInstance) && registrationId.equals(currentRegistration);
    }
}
