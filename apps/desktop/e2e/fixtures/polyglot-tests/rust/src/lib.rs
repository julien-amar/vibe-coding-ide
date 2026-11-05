//! Fixture for the Tests panel (Rust tests).

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds() {
        assert_eq!(add(1, 2), 3);
    }

    #[test]
    fn fails_on_purpose() {
        assert_eq!(add(2, 2), 5);
    }

    #[test]
    #[ignore]
    fn skipped() {}

    mod nested {
        #[test]
        fn works() {
            assert!(true);
        }
    }
}
