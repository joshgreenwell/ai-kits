//! Minimal interactive prompts for `setup`. `--yes` answers every question
//! with its default.

use std::io::{self, BufRead, Write};

#[derive(Debug)]
pub struct Prompt {
    pub assume_yes: bool,
}

impl Prompt {
    pub fn new(assume_yes: bool) -> Self {
        Prompt { assume_yes }
    }

    fn read_line(&self) -> Option<String> {
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line).ok()?;
        Some(line.trim().to_owned())
    }

    /// A yes/no question.
    pub fn confirm(&self, question: &str, default: bool) -> bool {
        if self.assume_yes {
            println!("{question} [{}]", if default { "yes" } else { "no" });
            return default;
        }
        print!("{question} [{}] ", if default { "Y/n" } else { "y/N" });
        let _ = io::stdout().flush();
        match self.read_line().as_deref() {
            Some("") | None => default,
            Some(answer) => matches!(answer.to_ascii_lowercase().as_str(), "y" | "yes"),
        }
    }

    /// A free-text question with a default.
    pub fn text(&self, question: &str, default: &str) -> String {
        if self.assume_yes {
            println!("{question} [{default}]");
            return default.to_owned();
        }
        print!("{question} [{default}] ");
        let _ = io::stdout().flush();
        match self.read_line() {
            Some(answer) if !answer.is_empty() => answer,
            _ => default.to_owned(),
        }
    }
}
