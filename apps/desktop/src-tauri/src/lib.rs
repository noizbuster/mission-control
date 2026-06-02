#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn greet(name: &str) -> String {
    format!("hello {name}")
}

pub fn run() {}

#[cfg(test)]
mod tests {
    use super::greet;

    #[test]
    fn greet_returns_expected_string() {
        assert_eq!(greet("mission-control"), "hello mission-control");
    }
}
