use super::*;
use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{
    NSArray, NSError, NSObject, NSObjectProtocol, NSOperatingSystemVersion, NSProcessInfo, NSString,
};
use objc2_user_notifications::*;
use std::{ptr::NonNull, sync::Mutex};

static INSTALL: Mutex<()> = Mutex::new(());
mod legacy;

fn modern() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 10,
        minorVersion: 14,
        patchVersion: 0,
    })
}

fn center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
}
fn withdraw(id: &str) {
    let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
    center().removePendingNotificationRequestsWithIdentifiers(&ids);
    center().removeDeliveredNotificationsWithIdentifiers(&ids);
}
pub fn initialize() {
    if !modern() {
        legacy::initialize();
        return;
    }
    // A terminated process cannot safely resume old notification callbacks.
    center().removeAllPendingNotificationRequests();
    center().removeAllDeliveredNotifications();
}
pub async fn permission(request: bool) -> Result<()> {
    if !modern() {
        return Ok(());
    }
    let status = authorization_status().await?;
    permission_for_status(status, request).await
}
async fn authorization_status() -> Result<isize> {
    let (tx, mut rx) = mpsc::channel(1);
    {
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // The framework keeps settings alive for this callback.
            let status = unsafe { settings.as_ref() }.authorizationStatus().0;
            let _ = tx.try_send(status);
        });
        center().getNotificationSettingsWithCompletionHandler(&handler);
    }
    let status = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .map_err(|_| "temporary-unavailable")?
        .ok_or("temporary-unavailable")?;
    #[cfg(debug_assertions)]
    eprintln!("macOS notification authorization status: {status}");
    Ok(status)
}
async fn permission_for_status(status: isize, request: bool) -> Result<()> {
    if status == UNAuthorizationStatus::Denied.0 {
        return Err("denied");
    }
    if status == UNAuthorizationStatus::Authorized.0
        || status == UNAuthorizationStatus::Provisional.0
    {
        return Ok(());
    }
    if status != UNAuthorizationStatus::NotDetermined.0 {
        return Err("unsupported");
    }
    // Reading settings must not prompt; explicit enable/permission gestures may ask.
    if !request {
        return Ok(());
    }
    let (tx, mut rx) = mpsc::channel(1);
    {
        let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            #[cfg(debug_assertions)]
            eprintln!(
                "macOS notification authorization callback granted: {}",
                granted.as_bool()
            );
            #[cfg(debug_assertions)]
            if !error.is_null() {
                let error = unsafe { &*error };
                eprintln!(
                    "macOS notification authorization error: {} {}",
                    error.domain(),
                    error.code()
                );
            }
            let _ = tx.try_send(if !error.is_null() {
                Err(notification_error(unsafe { &*error }))
            } else if granted.as_bool() {
                Ok(())
            } else {
                Err("denied")
            });
        });
        center().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &handler,
        );
    }
    match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
        Ok(Some(result)) => result,
        Ok(None) => Err("temporary-unavailable"),
        Err(_) => {
            #[cfg(debug_assertions)]
            eprintln!("macOS notification authorization callback timed out; rereading OS status");
            match authorization_status().await? {
                status if status == UNAuthorizationStatus::Denied.0 => Err("denied"),
                status
                    if status == UNAuthorizationStatus::Authorized.0
                        || status == UNAuthorizationStatus::Provisional.0 =>
                {
                    Ok(())
                }
                _ => Err("temporary-unavailable"),
            }
        }
    }
}
fn notification_error(error: &NSError) -> &'static str {
    if error.domain().to_string() == "UNErrorDomain" && error.code() == 1 {
        "denied"
    } else {
        "temporary-unavailable"
    }
}

struct DelegateIvars {
    owner: Owner,
    prefix: String,
    send: mpsc::Sender<Response>,
}
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "DiteroNotificationDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(
            &self,
            _center: &UNUserNotificationCenter,
            notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let id = notification.request().identifier().to_string();
            let options = if self.ivars().owner.current() && id.starts_with(&self.ivars().prefix) {
                if NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(
                    NSOperatingSystemVersion {
                        majorVersion: 11,
                        minorVersion: 0,
                        patchVersion: 0,
                    },
                ) {
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List
                } else {
                    #[allow(deprecated)]
                    UNNotificationPresentationOptions::Alert
                }
            } else {
                withdraw(&id);
                UNNotificationPresentationOptions(0)
            };
            completion.call((options,));
        }
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            if self.ivars().owner.current()
                && id.starts_with(&self.ivars().prefix)
                && &*response.actionIdentifier() == unsafe { UNNotificationDefaultActionIdentifier }
            {
                let _ = self.ivars().send.try_send(Response::Action(id));
            }
            completion.call(());
        }
    }
);
// UNUserNotificationCenter invokes delegates on its own queue; ivars are thread-safe.
unsafe impl Send for Delegate {}
unsafe impl Sync for Delegate {}
impl Delegate {
    fn new(owner: Owner, send: mpsc::Sender<Response>, prefix: String) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars {
            owner,
            prefix,
            send,
        });
        unsafe { msg_send![super(this), init] }
    }
}
pub struct Modern {
    owner: Owner,
    _delegate: Retained<Delegate>,
}
impl Modern {
    pub fn new(owner: Owner, send: mpsc::Sender<Response>, prefix: String) -> Result<Self> {
        let _guard = INSTALL.lock().map_err(|_| "temporary-unavailable")?;
        if !owner.current() {
            return Err("cancelled");
        }
        let delegate = Delegate::new(owner.clone(), send, prefix);
        center().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        Ok(Self {
            owner,
            _delegate: delegate,
        })
    }
    pub async fn show(&self, id: &str, body: &str) -> Result<()> {
        if !self.owner.current() {
            return Err("cancelled");
        }
        let (tx, mut rx) = mpsc::channel(1);
        {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str("Ditero"));
            content.setBody(&NSString::from_str(body));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(id),
                &content,
                None,
            );
            let owner = self.owner.clone();
            let key = id.to_owned();
            let handler = RcBlock::new(move |error: *mut NSError| {
                if !owner.current() {
                    withdraw(&key);
                }
                let result = if error.is_null() {
                    Ok(())
                } else {
                    Err(notification_error(unsafe { &*error }))
                };
                let _ = tx.try_send(result);
            });
            center().addNotificationRequest_withCompletionHandler(&request, Some(&handler));
        }
        let result = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .ok()
            .flatten()
            .unwrap_or(Err("temporary-unavailable"));
        if result.is_err() || !self.owner.current() {
            withdraw(id);
        }
        result?;
        Ok(())
    }
}

pub enum Backend {
    Modern(Modern),
    Legacy(legacy::Backend),
}
pub enum Display {
    Modern,
    Legacy(legacy::Display),
}
impl Backend {
    pub fn new(owner: Owner, send: mpsc::Sender<Response>, prefix: String) -> Result<Self> {
        if modern() {
            Modern::new(owner, send, prefix).map(Self::Modern)
        } else {
            legacy::Backend::new(owner, send, prefix).map(Self::Legacy)
        }
    }
    pub async fn show(&self, id: &str, body: &str) -> Result<Display> {
        match self {
            Self::Modern(backend) => backend.show(id, body).await.map(|()| Display::Modern),
            Self::Legacy(backend) => backend.show(id, body).map(Display::Legacy),
        }
    }
    pub fn close(&self, id: &str, display: Display) {
        match (self, display) {
            (Self::Modern(_), Display::Modern) => withdraw(id),
            (Self::Legacy(backend), Display::Legacy(display)) => backend.close(display),
            _ => eprintln!("notification backend mismatch"),
        }
    }
}
