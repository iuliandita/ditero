use super::*;
use ::windows::{
    core::{h, Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler},
    UI::Notifications::{
        NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier,
    },
};

const APP_ID: &str = "io.ditero.desktop";

fn notifier() -> Result<ToastNotifier> {
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|_| "unsupported")
}
pub fn initialize() {
    if !ToastNotificationManager::History()
        .and_then(|history| history.ClearWithId(&HSTRING::from(APP_ID)))
        .is_ok()
    {
        eprintln!("notification startup withdrawal unconfirmed");
    }
}
pub async fn permission(_request: bool) -> Result<()> {
    match notifier()?.Setting().map_err(|_| "temporary-unavailable")? {
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
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "temporary-unavailable")?
            .as_secs();
        let expires: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
            UniversalTime: ((seconds + 11_644_473_600 + 300) * 10_000_000) as i64,
        })
        .and_then(|value| value.cast())
        .map_err(|_| "temporary-unavailable")?;
        toast
            .SetExpirationTime(&expires)
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
        let failed = match toast.Failed(&TypedEventHandler::new(move |_, _| {
            if captured.current() {
                let _ = send.try_send(Response::Failed(key.clone()));
            }
            Ok(())
        })) {
            Ok(token) => token,
            Err(_) => {
                let _ = toast.RemoveActivated(action);
                return Err("temporary-unavailable");
            }
        };
        let key = id.to_owned();
        let dismissed = match toast.Dismissed(&TypedEventHandler::new(move |_, _| {
            // Classic desktop activation is reliable while the banner is on screen.
            // Do not leave a history entry whose click could launch a second process.
            if ToastNotificationManager::History()
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
        Ok(display)
    }
    pub fn close(&self, id: &str, display: Display) {
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
