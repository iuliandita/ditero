#![allow(deprecated)]
use super::*;
use objc2_foundation::{
    NSUserNotification, NSUserNotificationActivationType, NSUserNotificationCenter,
    NSUserNotificationCenterDelegate,
};

pub fn initialize() {
    let center = NSUserNotificationCenter::defaultUserNotificationCenter();
    for notification in center.scheduledNotifications() {
        center.removeScheduledNotification(&notification);
    }
    center.removeAllDeliveredNotifications();
}
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "DiteroLegacyNotificationDelegate"]
    #[ivars = Mutex<Option<DelegateIvars>>]
    struct LegacyDelegate;
    unsafe impl NSObjectProtocol for LegacyDelegate {}
    unsafe impl NSUserNotificationCenterDelegate for LegacyDelegate {
        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn present(&self, _center: &NSUserNotificationCenter, notification: &NSUserNotification) -> bool {
            self.ivars().lock().ok().is_some_and(|state| state.as_ref().is_some_and(|state| state.owner.current() && notification.identifier().is_some_and(|id| id.to_string().starts_with(&state.prefix))))
        }
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn activate(&self, _center: &NSUserNotificationCenter, notification: &NSUserNotification) {
            let Ok(state) = self.ivars().lock() else { return; };
            let Some(state) = state.as_ref().filter(|state| state.owner.current()) else { return; };
            if notification.activationType() != NSUserNotificationActivationType::ContentsClicked { return; }
            if let Some(id) = notification.identifier().map(|id| id.to_string()).filter(|id| id.starts_with(&state.prefix)) {
                let _ = state.send.try_send(Response::Action(id));
            }
        }
    }
);
unsafe impl Send for LegacyDelegate {}
unsafe impl Sync for LegacyDelegate {}
impl LegacyDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(Mutex::new(None));
        unsafe { msg_send![super(this), init] }
    }
}
// The legacy center stores an unretained delegate. Keep it alive independently of receivers.
static DELEGATE: std::sync::OnceLock<Retained<LegacyDelegate>> = std::sync::OnceLock::new();
pub struct Backend {
    owner: Owner,
}
pub struct Display(Retained<NSUserNotification>);
// The notification center accepts requests across threads; the payload is immutable after delivery.
unsafe impl Send for Display {}
unsafe impl Sync for Display {}
impl Backend {
    pub fn new(owner: Owner, send: mpsc::Sender<Response>, prefix: String) -> Result<Self> {
        let _guard = INSTALL.lock().map_err(|_| "temporary-unavailable")?;
        if !owner.current() {
            return Err("cancelled");
        }
        let delegate = DELEGATE.get_or_init(|| {
            let delegate = LegacyDelegate::new();
            unsafe {
                NSUserNotificationCenter::defaultUserNotificationCenter()
                    .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            }
            delegate
        });
        *delegate
            .ivars()
            .lock()
            .map_err(|_| "temporary-unavailable")? = Some(DelegateIvars {
            owner: owner.clone(),
            send,
            prefix,
        });
        Ok(Self { owner })
    }
    pub fn show(&self, id: &str, body: &str) -> Result<Display> {
        if !self.owner.current() {
            return Err("cancelled");
        }
        let notification = NSUserNotification::new();
        notification.setIdentifier(Some(&NSString::from_str(id)));
        notification.setTitle(Some(&NSString::from_str("Ditero")));
        notification.setInformativeText(Some(&NSString::from_str(body)));
        NSUserNotificationCenter::defaultUserNotificationCenter()
            .deliverNotification(&notification);
        Ok(Display(notification))
    }
    pub fn close(&self, display: Display) {
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        center.removeScheduledNotification(&display.0);
        center.removeDeliveredNotification(&display.0);
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Some(delegate) = DELEGATE.get() {
            if let Ok(mut state) = delegate.ivars().lock() {
                if state
                    .as_ref()
                    .is_some_and(|state| Arc::ptr_eq(&state.owner.retired, &self.owner.retired))
                {
                    *state = None;
                }
            }
        }
    }
}
