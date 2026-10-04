use crate::protocol::{self, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskLink {
    pub origin: String,
    pub task_id: String,
}

fn decode(raw: &str) -> Result<String> {
    let mut bytes = Vec::with_capacity(raw.len());
    let mut input = raw.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let a = input.next().ok_or("invalid-link")?;
            let b = input.next().ok_or("invalid-link")?;
            let hex = |n: u8| (n as char).to_digit(16).map(|n| n as u8);
            bytes.push(hex(a).ok_or("invalid-link")? * 16 + hex(b).ok_or("invalid-link")?);
        } else {
            if byte == b'+' {
                return Err("invalid-link");
            }
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| "invalid-link")
}

pub fn parse(raw: &str) -> Result<TaskLink> {
    if raw.len() > 2048
        || raw
            .bytes()
            .any(|b| !b.is_ascii_graphic() || b == b'\\' || b == b'#')
    {
        return Err("invalid-link");
    }
    let query = raw.strip_prefix("ditero://task?").ok_or("invalid-link")?;
    let mut origin = None;
    let mut task_id = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or("invalid-link")?;
        let value = decode(value)?;
        match key {
            "origin" if origin.is_none() => {
                let canonical = protocol::origin(&value).map_err(|_| "invalid-link")?;
                if value != canonical {
                    return Err("invalid-link");
                }
                origin = Some(canonical);
            }
            "taskId" if task_id.is_none() && protocol::id(&value) => task_id = Some(value),
            _ => return Err("invalid-link"),
        }
    }
    Ok(TaskLink {
        origin: origin.ok_or("invalid-link")?,
        task_id: task_id.ok_or("invalid-link")?,
    })
}

pub fn arguments(args: impl IntoIterator<Item = String>) -> Result<Option<TaskLink>> {
    let mut args = args.into_iter().skip(1);
    let Some(raw) = args.next() else {
        return Ok(None);
    };
    if args.next().is_some() {
        return Err("invalid-link");
    }
    parse(&raw).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    const LINK: &str = "ditero://task?origin=https%3A%2F%2Fexample.test&taskId=task%3A1";
    #[test]
    fn only_task_identity_and_canonical_https_origin_are_accepted() {
        assert_eq!(
            parse(LINK).unwrap(),
            TaskLink {
                origin: "https://example.test".into(),
                task_id: "task:1".into()
            }
        );
        assert!(arguments(vec!["ditero".into()]).unwrap().is_none());
        assert_eq!(
            arguments(vec!["ditero".into(), LINK.into()]).unwrap(),
            Some(parse(LINK).unwrap())
        );
        assert!(arguments(vec!["ditero".into(), LINK.into(), "other".into()]).is_err());
    }
    #[test]
    fn normalization_duplicate_keys_and_external_authority_are_refused() {
        for raw in [
            LINK.replace("ditero:", "DITERO:"),
            LINK.replace("task?", "task/?"),
            LINK.replace("task?", "user@task?"),
            LINK.replace("task?", "task:9?"),
            format!("{LINK}#fragment"),
            format!("{LINK}&token=secret"),
            format!("{LINK}&taskId=other"),
            format!("{LINK}&origin=https://other.test"),
            LINK.replace("https%3A", "http%3A"),
            LINK.replace("example.test", "example.test%2Fpath"),
            LINK.replace("example.test", "example.test%3Fq=x"),
            LINK.replace("example.test", "EXAMPLE.test"),
            LINK.replace("example.test", "example.test%3A443"),
            LINK.replace("task%3A1", ".."),
            LINK.replace("task%3A1", "task%253A1"),
            LINK.replace("task%3A1", "task+1"),
            LINK.replace("task%3A1", "%FF"),
            LINK.replace("task%3A1", "%0A"),
            LINK.replace("task%3A1", "%G0"),
            LINK.replace("task%3A1", "%A"),
            LINK.replace("task%3A1", ""),
            LINK.replace("taskId", "%74askId"),
            LINK.replace("ditero:", "ditero:\\"),
            format!(" {LINK}"),
            format!("{LINK}\n"),
            format!("{LINK}{}", "a".repeat(2048)),
            LINK.replace("task%3A1", &"a".repeat(129)),
        ] {
            assert!(parse(&raw).is_err(), "accepted {raw:?}");
        }
    }
}
