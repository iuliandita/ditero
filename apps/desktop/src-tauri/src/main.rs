mod attachments;
mod deep_links;
mod host;
#[cfg(all(debug_assertions, target_os = "macos"))]
#[path = "../../tests/journeys/hook.rs"]
mod journeys;
mod notifications;
mod offline;
mod protocol;
mod request_fence;
mod vault;
fn main() {
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if journeys::keystore_cli() || journeys::notifications_cli() {
        return;
    }
    host::run();
}
