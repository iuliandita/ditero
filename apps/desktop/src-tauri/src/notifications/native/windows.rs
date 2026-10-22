use super::*;
use ::windows::{
    core::{h, Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    UI::Notifications::{
        NotificationSetting, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    },
};

const APP_ID: &str = "io.ditero.desktop";

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { RoUninitialize() };
        }
    }
}
thread_local! {
    static APARTMENT: std::cell::OnceCell<Apartment> = const { std::cell::OnceCell::new() };
}
fn apartment() -> Result<()> {
    // A cached agile factory does not initialize each Tokio worker's apartment.
    APARTMENT.with(|slot| {
        if slot.get().is_some() {
            return Ok(());
        }
        let owns = match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => true,
            Err(error) if error.code().0 == 0x80010106u32 as i32 => false,
            Err(error) => return Err(failure("initialize", &error, "temporary-unavailable")),
        };
        let _ = slot.set(Apartment(owns));
        Ok(())
    })
}
fn notifier() -> Result<ToastNotifier> {
    apartment()?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|error| failure("create", &error, "unsupported"))
}
fn failure(stage: &str, error: &::windows::core::Error, state: &'static str) -> &'static str {
    #[cfg(debug_assertions)]
    eprintln!(
        "Windows notification {stage} HRESULT: {:#010x}",
        error.code().0
    );
    let _ = (stage, error);
    state
}
pub fn initialize() {
    if apartment().is_err() {
        eprintln!("notification startup initialization unconfirmed");
        return;
    }
    if !ToastNotificationManager::History()
        .and_then(|history| history.ClearWithId(&HSTRING::from(APP_ID)))
        .is_ok()
    {
        eprintln!("notification startup withdrawal unconfirmed");
    }
}
fn expiration(seconds_from_now: u64) -> Result<IReference<DateTime>> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "temporary-unavailable")?
        .as_secs();
    PropertyValue::CreateDateTime(DateTime {
        UniversalTime: ((seconds + 11_644_473_600 + seconds_from_now) * 10_000_000) as i64,
    })
    .and_then(|value| value.cast())
    .map_err(|_| "temporary-unavailable")
}
fn register_identity(notifier: &ToastNotifier) -> Result<()> {
    // Win32 Setting returns ELEMENT_NOT_FOUND before the first toast. Match the
    // Windows Community Toolkit's suppressed, short-lived identity registration.
    let xml = XmlDocument::new().map_err(|_| "temporary-unavailable")?;
    xml.LoadXml(h!("<toast><visual><binding template='ToastGeneric'><text>Ditero</text></binding></visual></toast>"))
        .map_err(|_| "temporary-unavailable")?;
    let toast =
        ToastNotification::CreateToastNotification(&xml).map_err(|_| "temporary-unavailable")?;
    toast
        .SetSuppressPopup(true)
        .map_err(|_| "temporary-unavailable")?;
    toast
        .SetTag(h!("permission-probe"))
        .map_err(|_| "temporary-unavailable")?;
    toast
        .SetGroup(h!("ditero-init"))
        .map_err(|_| "temporary-unavailable")?;
    toast
        .SetExpirationTime(&expiration(15)?)
        .map_err(|_| "temporary-unavailable")?;
    notifier
        .Show(&toast)
        .map_err(|error| failure("register", &error, "temporary-unavailable"))?;
    let hidden = notifier.Hide(&toast);
    let removed = ToastNotificationManager::History().and_then(|history| {
        history.RemoveGroupedTagWithId(
            h!("permission-probe"),
            h!("ditero-init"),
            &HSTRING::from(APP_ID),
        )
    });
    hidden
        .and(removed)
        .map_err(|error| failure("register-withdraw", &error, "temporary-unavailable"))
}
pub async fn permission(_request: bool) -> Result<()> {
    let notifier = notifier()?;
    let setting = match notifier.Setting() {
        Err(error) if error.code().0 == 0x80070490u32 as i32 => {
            register_identity(&notifier)?;
            notifier.Setting()
        }
        result => result,
    }
    .map_err(|error| failure("setting", &error, "temporary-unavailable"))?;
    match setting {
        NotificationSetting::Enabled => Ok(()),
        _ => Err("denied"),
    }
}
pub struct Backend {
    notifier: ToastNotifier,
    owner: Owner,
    send: mpsc::Sender<Response>,
}
pub struct Display {
    toast: ToastNotification,
    action: i64,
    failed: i64,
    dismissed: i64,
}
impl Backend {
    pub fn new(owner: Owner, send: mpsc::Sender<Response>, _prefix: String) -> Result<Self> {
        if !owner.current() {
            return Err("cancelled");
        }
        Ok(Self {
            notifier: notifier()?,
            owner,
            send,
        })
    }
    pub async fn show(&self, id: &str, body: &str) -> Result<Display> {
        if !self.owner.current() {
            return Err("cancelled");
        }
        permission(false).await?;
        apartment()?;
        // Construct text nodes instead of interpolating localized text into XML.
        let xml = XmlDocument::new().map_err(|_| "temporary-unavailable")?;
        xml.LoadXml(h!("<toast duration='long' activationType='foreground'><visual><binding template='ToastGeneric'><text>Ditero</text><text></text></binding></visual></toast>")).map_err(|_| "temporary-unavailable")?;
        let node = xml
            .GetElementsByTagName(h!("text"))
            .and_then(|nodes| nodes.Item(1))
            .map_err(|_| "temporary-unavailable")?;
        let text = xml
            .CreateTextNode(&HSTRING::from(body))
            .map_err(|_| "temporary-unavailable")?;
        node.AppendChild(&text)
            .map_err(|_| "temporary-unavailable")?;
        let toast = ToastNotification::CreateToastNotification(&xml)
            .map_err(|_| "temporary-unavailable")?;
        toast
            .SetTag(&HSTRING::from(id))
            .map_err(|_| "temporary-unavailable")?;
        toast
            .SetGroup(h!("ditero"))
            .map_err(|_| "temporary-unavailable")?;
        toast
            .SetExpirationTime(&expiration(300)?)
            .map_err(|_| "temporary-unavailable")?;
        let captured = self.owner.clone();
        let send = self.send.clone();
        let key = id.to_owned();
        let action = toast
            .Activated(&TypedEventHandler::new(move |_, _| {
                if captured.current() {
                    let _ = send.try_send(Response::Action(key.clone()));
                }
                Ok(())
            }))
            .map_err(|_| "temporary-unavailable")?;
        let captured = self.owner.clone();
        let send = self.send.clone();
        let key = id.to_owned();
        let failed = match toast.Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _args| {
                #[cfg(debug_assertions)]
                if let Some(args) = _args.as_ref() {
                    eprintln!(
                        "Windows notification failed: {:?}",
                        args.ErrorCode().map_err(|e| e.code())
                    );
                }
                if captured.current() {
                    let _ = send.try_send(Response::Failed(key.clone()));
                }
                Ok(())
            }),
        ) {
            Ok(token) => token,
            Err(_) => {
                let _ = toast.RemoveActivated(action);
                return Err("temporary-unavailable");
            }
        };
        let key = id.to_owned();
        let dismissed = match toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, _args| {
            #[cfg(debug_assertions)]
            if let Some(args) = _args.as_ref() {
                eprintln!(
                    "Windows notification dismissed: {:?}",
                    args.Reason().map(|reason| reason.0).map_err(|e| e.code())
                );
            }
            // Classic desktop activation is reliable while the banner is on screen.
            // Do not leave a history entry whose click could launch a second process.
            if apartment().is_err()
                || ToastNotificationManager::History()
                    .and_then(|history| {
                        history.RemoveGroupedTagWithId(
                            &HSTRING::from(&key),
                            h!("ditero"),
                            &HSTRING::from(APP_ID),
                        )
                    })
                    .is_err()
            {
                eprintln!("notification history withdrawal unconfirmed");
            }
            Ok(())
        })) {
            Ok(token) => token,
            Err(_) => {
                let _ = toast.RemoveActivated(action);
                let _ = toast.RemoveFailed(failed);
                return Err("temporary-unavailable");
            }
        };
        let display = Display {
            toast,
            action,
            failed,
            dismissed,
        };
        if self.notifier.Show(&display.toast).is_err() {
            self.close(id, display);
            return Err("temporary-unavailable");
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "Windows notification submitted: suppressed={:?}, history={:?}",
            display.toast.SuppressPopup().map_err(|e| e.code()),
            ToastNotificationManager::History()
                .and_then(|h| h.GetHistoryWithId(&HSTRING::from(APP_ID)))
                .and_then(|v| v.Size())
                .map_err(|e| e.code())
        );
        Ok(display)
    }
    pub fn close(&self, id: &str, display: Display) {
        if apartment().is_err() {
            eprintln!("notification withdrawal initialization unconfirmed");
            return;
        }
        let _ = display.toast.RemoveActivated(display.action);
        let _ = display.toast.RemoveFailed(display.failed);
        let _ = display.toast.RemoveDismissed(display.dismissed);
        let hidden = self.notifier.Hide(&display.toast);
        let removed = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupedTagWithId(&HSTRING::from(id), h!("ditero"), &HSTRING::from(APP_ID))
        });
        if hidden.is_err() || removed.is_err() {
            eprintln!("notification withdrawal unconfirmed");
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = apartment();
    }
}
